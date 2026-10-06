"""Contract tests for model-manager "position isolation".

The model manager page temporarily moves the model to the safe-zone center,
so every position write on this page must carry an isolation flag. When the
backend sees the flag and already has a record for the model, it keeps the
stored position; otherwise the next autosave / "save settings" click would
write the centered position into the global preferences and the main page
would move too.

How it works: at the top of each runtime's ``saveUserPreferences``
(Live2D / VRM / MMD) the code checks for ``window.ModelManagerSafetyZone``;
when present it calls ``rewritePositionWrite()`` to get the rewritten position
plus the preservePosition flag, then forwards the flag as ``preserve_position``
in the request body. PNGTuber strips the position fields directly in
page-controller instead.

These tests pin the "both sides must stay aligned" contract: parameter order,
the rewrite call, forwarding of the isolation flag, the leave-restore timing,
and the PNGTuber position field names. If an upstream change alters a
signature or field name, this file goes red instead of letting the protection
silently break.
"""

import re
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
GUARD_JS = PROJECT_ROOT / "static" / "js" / "model_manager" / "safety-zone-guard.js"
PAGE_CONTROLLER_JS = PROJECT_ROOT / "static" / "js" / "model_manager" / "page-controller.js"
PNGTUBER_CORE_JS = PROJECT_ROOT / "static" / "pngtuber-core.js"
MODEL_MANAGER_TEMPLATE = PROJECT_ROOT / "templates" / "model_manager.html"

# saveUserPreferences parameter lists of the three runtimes:
# index 1 = position, 4 = display, 5 = viewport
RUNTIME_PREFERENCE_SAVERS = {
    "static/live2d/live2d-core.js": "modelPath, position, scale, parameters, display, viewport",
    "static/vrm/vrm-core.js": "modelPath, position, scale, rotation, display, viewport, cameraPosition",
    "static/mmd/mmd-core.js": "modelPath, position, scale, rotation, display, viewport, cameraPosition",
}


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _function_body(source: str, header: str) -> str:
    """Slice an approximate range from ``header`` up to the next same-level ``}``, long enough for string assertions."""
    start = source.index(header)
    # 窗口只向后延长，因此“先 A 后 B”的顺序断言不受影响；放宽到 2000 是为了容纳
    # tryCenter 里为「按模型身份记录进入前的中心」新增的注释与代码，否则 applyCentering
    # 会被挤出窗口。
    return source[start:start + 2000]


def _parse_signature_params(source: str, expected_params: str):
    # Match only the definition (async ... ) {), never a call site.
    match = re.search(r"async saveUserPreferences\(([^)]*)\)\s*\{", source)
    assert match, "saveUserPreferences definition not found"
    actual = re.sub(r"\s+", "", match.group(1))
    assert actual == re.sub(r"\s+", "", expected_params), (
        f"saveUserPreferences signature changed: {actual}"
    )
    return [part.strip() for part in match.group(1).split(",")]


def test_runtime_save_signatures_keep_position_display_viewport_slots():
    """Parameter positions are an implicit contract of the rewrite logic; pin them down."""
    for relative_path, expected_params in RUNTIME_PREFERENCE_SAVERS.items():
        params = _parse_signature_params(_read(PROJECT_ROOT / relative_path), expected_params)
        assert params[0] == "modelPath"
        assert params[1] == "position", f"{relative_path}: 2nd parameter is no longer position"
        assert params[4] == "display", f"{relative_path}: 5th parameter is no longer display"
        assert params[5] == "viewport", f"{relative_path}: 6th parameter is no longer viewport"


def test_runtimes_ask_the_safety_zone_module_before_saving_position():
    """Each runtime must ask the model-manager module for rewritten values and write them back into position/display/viewport."""
    for relative_path in RUNTIME_PREFERENCE_SAVERS:
        source = _read(PROJECT_ROOT / relative_path)
        body = _function_body(source, "async saveUserPreferences(")
        assert "window.ModelManagerSafetyZone" in body, f"{relative_path}: position rewrite not wired in"
        assert "rewritePositionWrite(modelPath, position, display, viewport)" in body, (
            f"{relative_path}: rewrite function called with wrong arguments"
        )
        assert "position = scoped.position;" in body
        assert "display = scoped.display;" in body
        assert "viewport = scoped.viewport;" in body


def test_runtime_rewrite_happens_before_position_is_consumed():
    """VRM snapshots ``display`` into ``displaySnapshot`` at the top of the function, so the rewrite must run before it."""
    source = _read(PROJECT_ROOT / "static" / "vrm" / "vrm-core.js")
    body = _function_body(source, "async saveUserPreferences(")
    assert body.index("rewritePositionWrite(") < body.index("const displaySnapshot = display")


def test_safety_zone_module_exposes_rewrite_position_write():
    source = _read(GUARD_JS)
    assert "async function rewritePositionWrite(modelPath, position, display, viewport) {" in source
    assert "rewritePositionWrite" in _function_body(source, "window.ModelManagerSafetyZone = {")
    # This module only loads on the manager page: off-page the runtime check is naturally false.
    assert "model-manager-page" in source


def test_pngtuber_position_fields_are_stripped_before_staging():
    """PNGTuber never writes position: both layout offset fields must be stripped before staging."""
    pngtuber_source = _read(PNGTUBER_CORE_JS)
    layout_fields = set(re.findall(r"offset[XY]:\s*'([^']+)'", pngtuber_source))
    assert layout_fields == {
        "offset_x",
        "offset_y",
        "mobile_offset_x",
        "mobile_offset_y",
    }, f"PNGTuber position field names changed: {sorted(layout_fields)}"

    staging = _function_body(_read(PAGE_CONTROLLER_JS), "function stageModelManagerPNGTuberPlacement(")
    for field in sorted(layout_fields):
        assert f"'{field}'" in staging, f"PNGTuber staging did not strip position field {field}"
    # Only position is stripped: other fields such as scale are still merged as usual.
    assert "mergePNGTuberConfigForSave(" in staging
    assert "delete placementForSave[key]" in staging


def test_pngtuber_staging_still_marks_unsaved_changes():
    """Position is not persisted, but staging itself must still work (or the save button stays locked)."""
    staging = _function_body(_read(PAGE_CONTROLLER_JS), "function stageModelManagerPNGTuberPlacement(")
    assert "window.hasUnsavedChanges = true;" in staging
    assert "savePositionBtn.disabled = false;" in staging


def test_safety_zone_script_is_loaded_on_the_manager_page():
    template = _read(MODEL_MANAGER_TEMPLATE)
    script = "/static/js/model_manager/safety-zone-guard.js"
    assert script in template, "model manager page does not load the safety-zone module"
    assert template.index(script) > template.index("/static/js/model_manager/background-model-drag.js")


def test_pngtuber_position_fields_are_stripped_from_runtime_config_at_save_time():
    """When saving the character, pngtuberManager.config is merged last, so the offset fields must be stripped again."""
    pngtuber_source = _read(PNGTUBER_CORE_JS)
    layout_fields = sorted(set(re.findall(r"offset[XY]:\s*'([^']+)'", pngtuber_source)))
    source = _read(PAGE_CONTROLLER_JS)
    window_ = source[source.index("const runtimePNGTuberSource"):source.index("const runtimePNGTuberSource") + 900]
    assert "Object.assign({}, runtimePNGTuberSource)" in window_, (
        "must copy the runtime config before stripping fields, not mutate pngtuberManager.config"
    )
    for field in layout_fields:
        assert f"'{field}'" in window_, f"runtime config position field {field} not stripped at save time"


def test_load_snapshot_is_captured_before_centering_and_survives_repeated_ready_events():
    """Live2D fires two ready events per load: the snapshot must be recorded before moving and not overwritten for the same model."""
    source = _read(GUARD_JS)
    try_center = _function_body(source, "function tryCenter(")
    assert "captureLoadSnapshot();" in try_center, "load snapshot not recorded before centering"
    assert try_center.index("captureLoadSnapshot();") < try_center.index("applyCentering();"), (
        "snapshot must be recorded before applyCentering, otherwise it captures the centered position"
    )
    capture = source[source.index("function captureLoadSnapshot("):source.index("function resolvePositionSubstitute(")]
    assert "loadSnapshotByType.set(type, record)" in capture
    assert "String(existing.path || '') === String(record.path || '')" in capture, (
        "repeated ready events for the same path must keep the first snapshot, preventing it from being overwritten by the centered position"
    )


def test_live2d_load_binds_persisted_key_to_config_url_alias():
    """Live2D persists by currentModelInfo.path but loads by model_config_url.

    Those two strings can differ, so the page must bind them as an explicit
    alias during the same load call; otherwise the load snapshot never matches
    the save path and the centered position leaks into the model preferences
    when the record is first created.
    """
    guard = _read(GUARD_JS)
    # The alias registrar exists and is exported for the page to call.
    assert "function registerModelPathAlias(" in guard
    assert "registerModelPathAlias" in _function_body(guard, "window.ModelManagerSafetyZone = {")
    register_body = _function_body(guard, "function registerModelPathAlias(")
    assert "modelPathAliases.set(canonical, canonical)" in register_body
    assert "modelPathAliases.set(alias, canonical)" in register_body

    # Matching resolves through the alias map and rejects empty/unknown paths
    # instead of passing them through.
    match_body = _function_body(guard, "function preferencePathMatches(")
    assert "if (!left || !right) return false;" in match_body, (
        "unknown paths must be rejected, not silently accepted"
    )
    assert "modelPathAliases.get(left)" in match_body

    # The page binds the persisted key and the actually-loaded config URL.
    controller = _read(PAGE_CONTROLLER_JS)
    assert "registerModelPathAlias(modelInfo.path, modelConfig.url)" in controller


def test_runtimes_forward_preserve_position_flag():
    """The preservePosition flag from the rewrite result must be forwarded as ``preserve_position`` in the payload."""
    for relative_path in RUNTIME_PREFERENCE_SAVERS:
        source = _read(PROJECT_ROOT / relative_path)
        assert "scoped.preservePosition" in source, (
            f"{relative_path}: rewrite result does not read the position-isolation flag"
        )
        assert "preserve_position" in source, (
            f"{relative_path}: position-isolation flag not written into the request payload"
        )


def test_guard_has_no_stored_position_ledger():
    """The stored-position ledger (prefetching all backend positions) is fully removed; isolation now relies on the backend ``preserve_position`` flag."""
    source = _read(GUARD_JS)
    for removed in (
        "fetchStoredPositions",
        "ensureStoredPositions",
        "lookupStoredEntry",
        "storedPositionByPath",
        "storedPositionsPromise",
        "PREFERENCES_ENDPOINT",
    ):
        assert removed not in source, f"ledger remnant: {removed}"
    # The rewrite function still returns the isolation flag and keeps its async
    # signature so runtimes can call it as before.
    assert "preservePosition: true" in source


def test_rewrite_returns_preserve_position_and_uses_load_snapshot_only():
    """The rewrite only supplies the load snapshot as the payload position, and always marks the backend position as preserved."""
    source = _read(GUARD_JS)
    rewrite = _function_body(source, "async function rewritePositionWrite(")
    assert "preservePosition: true" in rewrite
    # No ledger lookups: the rewrite body must not call ledger helpers.
    assert "lookupStoredEntry" not in rewrite
    assert "ensureStoredPositions" not in rewrite


def test_leave_restore_waits_for_real_unload():
    """Restore only on a real unload: ``beforeunload`` can be cancelled by the unsaved-changes prompt, so it must not restore there."""
    source = _read(GUARD_JS)
    hooks = _function_body(source, "function bindWindowHooks(")
    assert "addEventListener('pagehide'" in hooks
    assert "addEventListener('beforeunload'" not in hooks, (
        "beforeunload can be cancelled by the unsaved-changes prompt; restoring there would clear savedCenter too early"
    )
    # Skip restore when pagehide enters bfcache (persisted).
    page_hide = _function_body(source, "function onPageHide(")
    assert "event.persisted" in page_hide


def test_leave_restore_clears_saved_center_only_after_move():
    """Clear ``saved_center`` only after a successful move; keep it on failure so it can retry."""
    source = _read(GUARD_JS)
    restore = _function_body(source, "function restoreOnLeave(")
    assert restore.index("moveModelScreenBy(") < restore.index("savedCenter = null")


def test_leave_restore_is_scoped_to_the_active_model_identity():
    """The pre-centering center must be keyed by model identity, not shared page-wide.

    A single page-wide record is reused after a model switch, so restoreOnLeave
    moves the new model to the previous model's center. Recording and restoring
    must be scoped to the active model identity, and restore must refuse to move
    when the stored center belongs to a different model.
    """
    source = _read(GUARD_JS)

    identity = _function_body(source, "function currentModelIdentity(")
    # Same identity source as the load snapshot, so both mechanisms agree.
    assert "_lastLoadedModelPath" in identity
    assert "model.url" in identity
    # PNGTuber must key on the active config (idle_image), not a constant, otherwise two
    # different PNGTuber configs share one identity and the record is never replaced.
    assert "config.idle_image" in identity

    try_center = _function_body(source, "function tryCenter(")
    assert "savedCenterPath !== identity" in try_center
    assert "savedCenterPath = identity" in try_center

    restore = _function_body(source, "function restoreOnLeave(")
    assert "currentModelIdentity()" in restore
    assert "savedCenterPath !== identity" in restore
    assert restore.index("savedCenterPath !== identity") < restore.index("moveModelScreenBy(")
    assert "savedCenterPath = null" in restore