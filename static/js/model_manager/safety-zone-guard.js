/**
 * 模型管理器页「安全区」防护。
 *
 * 背景：模型位置是全局持久化的，当模型停在屏幕左侧、落入 #sidebar 的水平覆盖范围时，
 * 进入 /model_manager 后模型会被侧边栏完全盖住，且由于指针命中的是 sidebar DOM，
 * 无法把模型拖出来。
 *
 * 本模块只在本页（body.model-manager-page）生效，主界面行为完全不变：
 *   1. 每次模型加载完成后，把模型中心移到「安全区几何中心」（临时位移，不写库）；
 *      注意本页一次进入可能加载多次模型（switchModelDisplay 先载一个，随后
 *      loadCurrentCharacterModel 再载角色真正的模型），后一次会把该模型自己的存档
 *      位置写回去，所以这里必须「每次就绪都居中」，否则最终位置会退回主页面那套。
 *   2. 离开页面时把模型移回进入前的屏幕中心（同样不写库）；
 *   3. 拖拽结束后，若模型中心水平落入遮挡区，则把它推回安全区（仅水平方向）。
 *      本页有两条拖拽路径——「空白背景拖动」（background-model-drag.js）和
 *      「直接抓住模型拖动」（各运行时自己的拖拽代码）。两者都要覆盖，因此这里
 *      统一在全局 pointerup/pointercancel 后做多次幂等的 clamp，跨过各运行时
 *      260~300ms 的回弹/保存动画再复核。
 *   4. 本页不写位置：改写函数返回 preservePosition=true，运行时把它透传成请求体里的
 *      preserve_position，后端见到该标记且已有该模型记录时保留后端已存的位置，
 *      所以管理页的临时摆位绝不会影响主页面；缩放/旋转/参数/相机等仍照原样保存。
 *      （管理页的位置与主页面位置互不影响。）
 *      改写的入口是运行时里的判断：saveUserPreferences 开头看本模块在不在，在就调用
 *      rewritePositionWrite() 拿改写后的 position/preservePosition。本模块只在管理页
 *      加载，主页面等其它页面分支不执行，因此不需要包装运行时函数。
 *
 * 所有模型类型统一用「屏幕 CSS 像素」做中间层，只用两个原语：
 *   getModelScreenCenter()  取模型中心的屏幕坐标
 *   moveModelScreenBy(dx,dy) 按屏幕像素平移模型
 * 居中 / 恢复 / clamp 全部复用它们，避免各类型私有坐标换算重复出错。
 */
(function installModelManagerSafetyZoneGuard() {
    'use strict';

    const SIDEBAR_MARGIN_PX = 24;
    const FALLBACK_HALF_WIDTH_PX = 150;
    const READINESS_POLL_INTERVAL_MS = 200;
    const READINESS_TIMEOUT_MS = 30000;
    const DRAGGING_BODY_CLASS = 'model-manager-background-dragging';
    // 居中后按这些时间点复核：一次进入可能触发多次模型加载，且各运行时的位置写回
    // （存档位置套用、边界回弹、视口归一化）不一定发生在 ready 事件之前。
    const CENTERING_REASSERT_DELAYS_MS = [0, 60, 160, 320, 600, 1000];
    // 松手后补做安全区约束的时间点：立即一次给出反馈，其余几次用于跨过各运行时
    // 的边界回弹（VRM/MMD/PNGTuber 260ms、Live2D 300ms 防抖吸附）之后的位置写回。
    const POST_INTERACTION_CLAMP_DELAYS_MS = [0, 120, 320, 700];
    // 各运行时的「模型已加载完成」事件；本页只认当前激活类型的就绪状态。
    const MODEL_READY_EVENTS = [
        'neko-live2d-model-ready',
        'live2d-model-ready',
        'vrm-model-loaded',
        'mmd-model-loaded',
        'pngtuber-model-loaded'
    ];
    // switchModelDisplay 在切换模型类型时派发，用于「还没就绪就先等着」。
    const MODE_SET_EVENT = 'neko-model-manager-mode-set';
    // 排查用：控制台执行 localStorage.setItem('nekoSafetyZoneDebug','1') 后，每次改写都会打印明细
    const DEBUG_FLAG_KEY = 'nekoSafetyZoneDebug';

    let savedCenter = null;
    // 这份「进入前的中心」属于哪个模型（取值见 currentModelIdentity）。必须成对使用：
    // 切换模型后身份会变，据此判断记录是否还有效，否则离开时会把当前模型搬到上一个
    // 模型的中心去（审查指出：切换模型后最后一个模型会被移回之前模型的位置）。
    let savedCenterPath = null;
    let readyListenersBound = false;
    let pollTimerId = null;
    let readinessDeadline = 0;
    let centeringTimers = [];
    let clampTimers = [];
    let pointerDown = false;
    let stopped = false;
    let loadSnapshotByType = new Map();

    function isMmPage() {
        return !!(document.body && document.body.classList.contains('model-manager-page'));
    }

    function isDragging() {
        return !!(document.body && document.body.classList.contains(DRAGGING_BODY_CLASS));
    }

    function dragController() {
        return window.ModelManagerBackgroundDragController || null;
    }

    // 复用 background-model-drag.js 的类型判定，避免两套判断漂移。
    function getActiveModelType() {
        const controller = dragController();
        if (controller && typeof controller.getActiveModelType === 'function') {
            return controller.getActiveModelType();
        }
        return 'live2d';
    }

    function getLive3DSubType() {
        const controller = dragController();
        if (controller && typeof controller.getLive3DSubType === 'function') {
            return controller.getLive3DSubType();
        }
        return 'vrm';
    }

    function live3dManager() {
        return getLive3DSubType() === 'mmd' ? window.mmdManager : window.vrmManager;
    }

    // 取当前活动模型的身份标识。作用：把「进入前的中心」和具体模型绑定 —— 切换模型后
    // 身份会变，记录随之失效（见 tryCenter / restoreOnLeave）。
    // 取值规则刻意与「加载时快照」保持一致，避免同一个模块里出现两套识别标准。
    // 取不到时返回空串：此时无法区分模型，退化为旧行为，但绝不会因此误伤（不会跨模型搬移）。
    function currentModelIdentity() {
        const type = getActiveModelType();

        if (type === 'live2d') {
            // Live2D：用运行时记录的加载路径，与快照登记的是同一个值。
            const manager = window.live2dManager;
            return String((manager && manager._lastLoadedModelPath) || '');
        }

        if (type === 'pngtuber') {
            // PNGTuber 没有路径字段，用当前配置的 idle_image 作为身份：切换到另一份配置时
            // 这个值会变，从而正确替换旧记录（此前返回固定串 'pngtuber'，两份配置身份相同，
            // 切换时不替换、离开时仍被搬回上一份配置的中心）。取不到时退回固定串兜底，
            // 退化为旧行为但不会误伤。
            const manager = window.pngtuberManager;
            const config = manager && manager.config;
            const idleImage = config && config.idle_image;
            return idleImage ? String(idleImage) : 'pngtuber';
        }

        // 3D（VRM / MMD）：用模型对象的 url，与快照登记的路径一致。
        const manager = live3dManager();
        const model = manager && manager.currentModel;
        return String((model && model.url) || '');
    }

    function sidebarRect() {
        const sidebar = document.getElementById('sidebar');
        if (!sidebar || typeof sidebar.getBoundingClientRect !== 'function') return null;
        const rect = sidebar.getBoundingClientRect();
        if (!rect || !Number.isFinite(rect.right)) return null;
        return rect;
    }

    function isLive2DReady(manager) {
        return !!(manager && manager.currentModel && !manager.currentModel.destroyed &&
            manager._isModelReadyForInteraction === true &&
            manager.pixi_app && manager.pixi_app.view && manager.pixi_app.renderer);
    }

    // Live2D 画布换算上下文：渲染逻辑坐标 <-> CSS 像素（与 background-model-drag.js 一致）。
    function live2dContext() {
        const manager = window.live2dManager;
        if (!isLive2DReady(manager)) return null;
        const canvas = manager.pixi_app.view;
        const screen = manager.pixi_app.renderer.screen;
        if (!canvas || typeof canvas.getBoundingClientRect !== 'function' || !screen) return null;
        const rect = canvas.getBoundingClientRect();
        if (!(rect.width > 0) || !(rect.height > 0)) return null;
        const scaleX = (Number(screen.width) || rect.width) / rect.width;
        const scaleY = (Number(screen.height) || rect.height) / rect.height;
        if (!(scaleX > 0) || !(scaleY > 0)) return null;
        return { manager, model: manager.currentModel, rect, scaleX, scaleY };
    }

    function boundsCenter(bounds) {
        if (!bounds) return null;
        const left = Number.isFinite(bounds.left) ? bounds.left : bounds.x;
        const top = Number.isFinite(bounds.top) ? bounds.top : bounds.y;
        const right = Number.isFinite(bounds.right) ? bounds.right : left + bounds.width;
        const bottom = Number.isFinite(bounds.bottom) ? bounds.bottom : top + bounds.height;
        if (![left, top, right, bottom].every(Number.isFinite)) return null;
        return { x: (left + right) / 2, y: (top + bottom) / 2 };
    }

    function boundsWidth(bounds) {
        if (!bounds) return NaN;
        if (Number.isFinite(bounds.left) && Number.isFinite(bounds.right)) {
            return bounds.right - bounds.left;
        }
        return Number(bounds.width);
    }

    function getModelScreenCenter() {
        const type = getActiveModelType();

        if (type === 'live2d') {
            const ctx = live2dContext();
            if (!ctx || typeof ctx.model.getBounds !== 'function') return null;
            let center;
            try {
                center = boundsCenter(ctx.model.getBounds());
            } catch (_) {
                return null;
            }
            if (!center) return null;
            return {
                x: ctx.rect.left + center.x / ctx.scaleX,
                y: ctx.rect.top + center.y / ctx.scaleY
            };
        }

        if (type === 'pngtuber') {
            const manager = window.pngtuberManager;
            if (!manager) return null;
            if (typeof manager.getModelCenterInWindow === 'function') {
                const center = manager.getModelCenterInWindow();
                if (center && Number.isFinite(center.x) && Number.isFinite(center.y)) {
                    return { x: center.x, y: center.y };
                }
                return null;
            }
            const container = manager.container;
            if (container && typeof container.getBoundingClientRect === 'function') {
                const rect = container.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
                }
            }
            return null;
        }

        const manager = live3dManager();
        const interaction = manager && manager.interaction;
        if (!interaction || typeof interaction._getProjectedModelCenterInWindow !== 'function') return null;
        const center = interaction._getProjectedModelCenterInWindow();
        if (!center || !Number.isFinite(center.x) || !Number.isFinite(center.y)) return null;
        return { x: center.x, y: center.y };
    }

    // 运行时自己正在拖拽/回弹/自动移动时不介入，避免两边抢位置。
    function isRuntimeBusy() {
        const type = getActiveModelType();

        if (type === 'live2d') {
            const manager = window.live2dManager;
            return !!(manager && (manager._isSnapping || manager._isDraggingModel || manager.isDragging));
        }

        if (type === 'pngtuber') {
            const manager = window.pngtuberManager;
            return !!(manager && (manager._dragState || manager._isDraggingModel ||
                manager.isDragging || manager._edgeSnapAnimationFrame));
        }

        const manager = live3dManager();
        const interaction = manager && manager.interaction;
        return !!(interaction && (interaction.isDragging || interaction._isSnappingModel));
    }

    // VRM 的 _moveModelCenterToWindowPoint 内部会 _cancelGuidedMovement({invalidateInteraction:true})，
    // 把 movementToken 自增。若这次调用撞上拖拽收尾（_endDrag）里 stillOwnsInteraction() 的检查，
    // 收尾会提前 return，导致边界回弹和位置保存被跳过。所以：
    //   - 有自动移动/转向在跑时直接不动（宁可少约束，也不打断运行时的流程）；
    //   - 否则调用前后保存/还原 movementToken，使这次位移对收尾流程完全透明。
    function isVrmGuidedMovementActive(interaction) {
        const isSet = (value) => value !== null && value !== undefined;
        return !!(interaction.isMoving || interaction._movementAction ||
            isSet(interaction._movementOwnerToken) || isSet(interaction._movementFinishingToken) ||
            isSet(interaction._smoothFacingFrame));
    }

    function moveModelScreenBy(dx, dy) {
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
        if (dx === 0 && dy === 0) return true;

        const type = getActiveModelType();

        if (type === 'live2d') {
            const ctx = live2dContext();
            if (!ctx) return false;
            ctx.model.x += dx * ctx.scaleX;
            ctx.model.y += dy * ctx.scaleY;
            ctx.manager.isFocusing = false;
            return true;
        }

        if (type === 'pngtuber') {
            const manager = window.pngtuberManager;
            if (!manager || typeof manager.moveModelCenterToWindowPoint !== 'function' ||
                typeof manager.getModelCenterInWindow !== 'function') {
                return false;
            }
            // 本页默认忽略已存偏移渲染（getRenderPlacement 归零），必须先进入编辑态，
            // 否则改 offset 不会产生任何视觉位移。
            if (typeof manager.beginModelManagerPositionEditing === 'function') {
                manager.beginModelManagerPositionEditing();
            }
            const center = manager.getModelCenterInWindow();
            if (!center) return false;
            return manager.moveModelCenterToWindowPoint(center.x + dx, center.y + dy) === true;
        }

        const manager = live3dManager();
        const interaction = manager && manager.interaction;
        if (!interaction ||
            typeof interaction._getProjectedModelCenterInWindow !== 'function' ||
            typeof interaction._moveModelCenterToWindowPoint !== 'function') {
            return false;
        }
        const isVrm = getLive3DSubType() !== 'mmd';
        if (isVrm && isVrmGuidedMovementActive(interaction)) return false;
        const center = interaction._getProjectedModelCenterInWindow();
        if (!center) return false;
        const token = isVrm ? interaction.movementToken : undefined;
        const moved = interaction._moveModelCenterToWindowPoint(center.x + dx, center.y + dy) === true;
        if (isVrm) interaction.movementToken = token;
        return moved;
    }

    function isModelReadyForActiveType() {
        const type = getActiveModelType();

        if (type === 'live2d') {
            return !!live2dContext();
        }

        if (type === 'pngtuber') {
            const manager = window.pngtuberManager;
            return !!(manager && manager.image &&
                typeof manager.getModelCenterInWindow === 'function' &&
                manager.getModelCenterInWindow());
        }

        const manager = live3dManager();
        return !!(manager && manager._isModelReadyForInteraction === true &&
            manager.interaction && getModelScreenCenter());
    }

    function computeTargetCenter() {
        const bar = sidebarRect();
        const right = bar && Number.isFinite(bar.right) ? bar.right : 0;
        return {
            x: (right + window.innerWidth) / 2,
            y: window.innerHeight / 2
        };
    }

    function applyCentering() {
        const current = getModelScreenCenter();
        if (!current) return false;
        const target = computeTargetCenter();
        return moveModelScreenBy(target.x - current.x, target.y - current.y);
    }

    // 用户此刻没在亲手操作（按着指针 / 正在拖背景）时，才允许自动摆位。
    function canTakeOverModel() {
        return !stopped && isMmPage() && !pointerDown && !isDragging();
    }

    // 更严格一档：运行时自己也在动（回弹/吸附/自动移动）时不插手，避免两边抢位置。
    function canAutoAdjust() {
        return canTakeOverModel() && !isRuntimeBusy();
    }

    function cancelPendingCentering() {
        while (centeringTimers.length) {
            window.clearTimeout(centeringTimers.pop());
        }
    }

    // 居中后按时间点复核几次：晚到的存档位置写回会被再次纠正，最终一定落在安全区中心。
    function scheduleCenteringReassert() {
        cancelPendingCentering();
        CENTERING_REASSERT_DELAYS_MS.forEach((delay) => {
            centeringTimers.push(window.setTimeout(() => {
                if (!canAutoAdjust()) return;
                applyCentering();
            }, delay));
        });
    }

    function cancelPendingClamps() {
        while (clampTimers.length) {
            window.clearTimeout(clampTimers.pop());
        }
    }

    function runClampPass() {
        if (!canAutoAdjust()) return;
        clampAfterDrag();
    }

    // 松手后补做几次（幂等）：第一次立即纠正，后面几次跨过运行时的回弹动画再复核。
    function scheduleClampPasses() {
        cancelPendingClamps();
        if (stopped || !isMmPage()) return;
        POST_INTERACTION_CLAMP_DELAYS_MS.forEach((delay) => {
            clampTimers.push(window.setTimeout(runClampPass, delay));
        });
    }

    // 只在「模型已就绪」时真正居中；否则交给轮询等它就绪。
    // 用户此刻正按着指针就不动（等他松手后由轮询补上），避免跟他抢模型。
    function tryCenter() {
        if (!canTakeOverModel() || !isModelReadyForActiveType()) return false;
        const current = getModelScreenCenter();
        if (!current) return false;
        // 必须在任何搬动之前记录「加载时位置」——它是本页唯一允许被写回去的位置，
        // 也是主页面会用的值。放在这里而不是就绪事件入口：一是保证记录时模型一定就绪，
        // 二是 Live2D 一次加载连发两个就绪事件，第二次进来模型已被居中，照搬会污染快照。
        captureLoadSnapshot();
        // 「进入前的中心」按模型身份保存：
        //   - 同一模型只记第一次，因此后面的居中复核（就绪事件连发、多次重试）不会把
        //     「已居中的位置」误当成原始位置覆盖进来；
        //   - 切换到新模型时身份变化，用新模型搬动前的中心替换掉上一个模型的记录，
        //     避免离开时拿旧模型的中心去恢复当前模型。
        const identity = currentModelIdentity();
        if (!savedCenter || savedCenterPath !== identity) {
            if (savedCenter && isDebugEnabled()) {
                console.log('[安全区] 进入前的中心随模型切换而替换', {
                    旧身份: savedCenterPath,
                    新身份: identity
                });
            }
            savedCenter = { cx: current.x, cy: current.y };
            savedCenterPath = identity;
        }
        // 关键点：必须如实反映「这次到底有没有把模型搬成功」。
        // applyCentering 内部经 moveModelScreenBy 搬模型，VRM 在运行时自己正在
        // 自动移动或平滑转向（isVrmGuidedMovementActive 为真）时会直接返回 false，
        // 表示「这次没搬」。旧写法忽略这个结果、一律返回 true，会让调度器
        // armCentering 误以为已经居中而立即 stopPolling 停止轮询，只在之后约 1 秒内
        // 补做几次复核；一旦这些复核也全部撞上「运行时正忙」，模型就永久停在加载时的
        // 位置（也就是主页面位置）且不再重试——这正是 VRM 偶发不居中的成因。
        // 改为：没搬成就返回 false，让轮询在 30 秒窗口内继续每 200ms 重试，直到搬成功。
        const centered = applyCentering();
        if (!centered) {
            if (isDebugEnabled()) {
                console.log('[安全区] 居中未成功（运行时正忙），保留轮询继续重试');
            }
            return false;
        }
        scheduleCenteringReassert();
        return true;
    }

    function stopPolling() {
        if (pollTimerId !== null) {
            window.clearInterval(pollTimerId);
            pollTimerId = null;
        }
    }

    function stopReadinessWatch() {
        stopPolling();
        if (!readyListenersBound) return;
        readyListenersBound = false;
        MODEL_READY_EVENTS.forEach((name) => window.removeEventListener(name, onModelReadySignal));
        window.removeEventListener(MODE_SET_EVENT, onModeSet);
    }

    // 每次「模型加载完成」或「切换模型类型」都重新摆位一次。
    function armCentering() {
        if (!isMmPage() || stopped) return;
        readinessDeadline = Date.now() + READINESS_TIMEOUT_MS;
        if (tryCenter()) {
            stopPolling();
            return;
        }
        if (pollTimerId !== null) return;
        pollTimerId = window.setInterval(() => {
            if (stopped || !isMmPage()) {
                stopPolling();
                return;
            }
            if (tryCenter()) {
                stopPolling();
                return;
            }
            if (Date.now() > readinessDeadline) stopPolling();
        }, READINESS_POLL_INTERVAL_MS);
    }

    function onModelReadySignal() {
        if (!isMmPage()) {
            stopReadinessWatch();
            return;
        }
        cancelPendingCentering();
        armCentering();
    }

    function onModeSet() {
        if (!isMmPage() || stopped) return;
        // 刚切换类型，新模型多半还没就绪：作废旧计划，重新等待并居中。
        cancelPendingCentering();
        armCentering();
    }

    function startReadinessWatch() {
        if (readyListenersBound) return;
        readyListenersBound = true;
        MODEL_READY_EVENTS.forEach((name) => window.addEventListener(name, onModelReadySignal));
        window.addEventListener(MODE_SET_EVENT, onModeSet);
        armCentering();
    }

    function restoreOnLeave() {
        if (stopped || !isMmPage()) return;
        const saved = savedCenter;
        if (!saved) return;
        // 身份校验：只在记录属于当前模型时才恢复。切换过模型后，记录里可能还是上一个
        // 模型的中心，此时直接返回、不做任何位移，绝不能把当前模型搬到别的模型的位置上。
        const identity = currentModelIdentity();
        if (savedCenterPath !== identity) {
            if (isDebugEnabled()) {
                console.log('[安全区] 跳过恢复：记录不属于当前模型', {
                    记录身份: savedCenterPath,
                    当前身份: identity
                });
            }
            return;
        }
        const current = getModelScreenCenter();
        // 取不到当前中心时保留 savedCenter，留给下一次机会，避免状态被提前清空。
        if (!current) return;
        // 位移成功后才清 savedCenter：若位移失败（运行时正忙等），保留快照以便后续重试。
        if (moveModelScreenBy(saved.cx - current.x, saved.cy - current.y)) {
            savedCenter = null;
            savedCenterPath = null;
        }
    }

    // pagehide 是「真正离开页面」才会触发的事件（beforeunload 会被「未保存确认」取消，
    // 在那里恢复会把模型位置弄乱且丢掉 savedCenter）。进入 bfcache（persisted）时页面
    // 可能被恢复，不还原位置，保留 savedCenter。
    function onPageHide(event) {
        if (event && event.persisted) return;
        restoreOnLeave();
    }

    // clamp 只是软约束：夹在 [140, 25% 窗口宽] 之间，避免过小挡不住、过大把模型顶到屏外。
    function boundHalfWidth(value) {
        const measured = Number.isFinite(value) && value > 0 ? value : FALLBACK_HALF_WIDTH_PX;
        const lower = 140;
        const upper = Math.max(lower, window.innerWidth * 0.25);
        return Math.max(lower, Math.min(measured, upper));
    }

    function estimateModelHalfWidth() {
        const type = getActiveModelType();

        if (type === 'live2d') {
            const ctx = live2dContext();
            if (ctx && typeof ctx.model.getBounds === 'function') {
                try {
                    const width = boundsWidth(ctx.model.getBounds());
                    if (Number.isFinite(width) && width > 0) {
                        return boundHalfWidth(width / 2 / ctx.scaleX);
                    }
                } catch (_) { /* 退回保守估计 */ }
            }
            return boundHalfWidth(NaN);
        }

        if (type === 'pngtuber') {
            const manager = window.pngtuberManager;
            const image = manager && manager.image;
            if (image && typeof image.getBoundingClientRect === 'function') {
                const rect = image.getBoundingClientRect();
                if (rect.width > 0) return boundHalfWidth(rect.width / 2);
            }
            return boundHalfWidth(NaN);
        }

        const manager = live3dManager();
        const canvas = manager && manager.renderer && manager.renderer.domElement;
        if (canvas && typeof canvas.getBoundingClientRect === 'function') {
            const rect = canvas.getBoundingClientRect();
            if (rect.width > 0) return boundHalfWidth(rect.width * 0.15);
        }
        return boundHalfWidth(NaN);
    }

    function clampAfterDrag() {
        if (!isMmPage() || isRuntimeBusy()) return false;
        const bar = sidebarRect();
        if (!bar) return false;
        const current = getModelScreenCenter();
        if (!current) return false;
        const minX = bar.right + estimateModelHalfWidth() + SIDEBAR_MARGIN_PX;
        if (current.x < minX) {
            return moveModelScreenBy(minX - current.x, 0);
        }
        return true;
    }

    function bindWindowHooks() {
        // 返回主页的两条路径（window.close / location.href='/'）都会触发 pagehide，
        // 因此不需要挂在按钮 click 上，避免用户取消「未保存确认」时把模型位置弄乱。
        // 只挂 pagehide：beforeunload 会被「未保存确认」取消，在那里恢复会提前清空
        // savedCenter，导致真正离开时无法还原。
        window.addEventListener('pagehide', onPageHide);
        // unload 兜底：极少数只触发 unload 不触发 pagehide 的场景，仍恢复一次
        // （pagehide 已恢复过时 savedCenter 为空，这里自动跳过）。
        window.addEventListener('unload', () => {
            restoreOnLeave();
            stopped = true;
            pointerDown = false;
            stopReadinessWatch();
            cancelPendingCentering();
            cancelPendingClamps();
        });
        // 用户一旦按下指针，就说明他要自己摆，立刻停掉所有自动摆位。
        window.addEventListener('pointerdown', () => {
            pointerDown = true;
            cancelPendingCentering();
            cancelPendingClamps();
        }, true);
        window.addEventListener('pointerup', () => {
            pointerDown = false;
            scheduleClampPasses();
        }, true);
        window.addEventListener('pointercancel', () => {
            pointerDown = false;
            scheduleClampPasses();
        }, true);
    }

    // ═══════════════════ 本页不写位置 ═══════════════════
    // 管理页会把模型临时摆到安全区中心，所以本页保存位置必须打上隔离标记：改写函数
    // 返回 preservePosition=true，运行时把它透传成请求体里的 preserve_position，后端见到
    // 该标记且已有该模型记录时，会保留后端已存的 position/display/viewport 不覆盖，
    // 于是管理页的临时摆位绝不落库，主页面不受影响。缩放、旋转、参数、相机等照常保存。
    //
    // 载荷里的 position 仍要给一个「合理值」：用「加载时快照」兜底（模型刚加载完、
    // 本模块还没搬动它那一刻的位置），首次保存（后端还没有该模型记录）时后端就用它建记录。
    //
    // 调用方式是「运行时里判断」：Live2D / VRM / MMD 的 saveUserPreferences 开头会看
    // 本模块在不在，在就问它要一份改写后的参数；PNGTuber 那处直接在 page-controller
    // 里摘掉位置字段。本模块只在模型管理页加载，所以其它页面这些分支根本不会执行
    // （主页面行为零变化），也就不需要「等运行时出现再补装」这类机制。

    function isUsablePosition(position, shape) {
        if (!position || typeof position !== 'object') return false;
        if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) return false;
        // 调用方给的是三维位置时，替换值也必须是三维，否则会被下游校验整单拒掉。
        const needsZ = !!(shape && typeof shape === 'object' && Number.isFinite(shape.z));
        return !needsZ || Number.isFinite(position.z);
    }

    // 路径别名表：同一次模型加载里，「持久化键」和「实际用于加载配置的 URL」可能是两个
    // 不同字符串。例如 Live2D 保存偏好用的是 currentModelInfo.path（后端按它建记录），
    // 而运行时记录的 _lastLoadedModelPath 往往等于后端返回的 model_config_url。两者只是
    // 指向同一个模型的两种写法，必须能互相匹配；否则加载时快照对不上，管理页居中位置
    // 会以「首次建记录」的形式被写进偏好。
    // 结构：归一化路径 -> 归一化持久化键（持久化键自身也登记，便于统一解析）。
    const modelPathAliases = new Map();

    // 偏好里的模型路径形式不一定和调用方一致（历史原因），所以按运行时自己的策略匹配：
    // 精确 → 去掉 query/hash 归一化 → 文件名（小写）相同。（对齐 live2d-init.js / vrm-core.js）
    function normalizePreferencePath(value) {
        const raw = value && typeof value === 'object' ? (value.url || value.path || '') : value;
        if (typeof raw !== 'string') return '';
        return raw.split('#')[0].split('?')[0].trim().replace(/\\/g, '/');
    }

    // 登记一对别名：canonicalPath 是后端持久化用的键（如 currentModelInfo.path），
    // aliasPath 是同一次加载里实际使用的配置 URL（如 model_config_url / _lastLoadedModelPath）。
    // 两者都归一化后指向同一个键，之后 preferencePathMatches 就能把它们认成同一个模型。
    // 空路径一律不登记：路径未知时宁可不匹配，也不能把位置记到别的模型头上。
    function registerModelPathAlias(canonicalPath, aliasPath) {
        const canonical = normalizePreferencePath(canonicalPath);
        const alias = normalizePreferencePath(aliasPath);
        if (!canonical || !alias) return false;
        modelPathAliases.set(canonical, canonical);
        modelPathAliases.set(alias, canonical);
        return true;
    }

    // 只在两条路径都能确定、且能解析到同一个持久化键时才算「同一个模型」。
    // 匹配顺序：归一化后完全相等 → 别名表里解析到同一个键。
    // 不做文件名兜底：同名文件可能分属不同模型，一旦猜错就会把别的模型的位置
    // 写到当前模型头上。匹配不上时宁可放弃替换，交给「加载时快照」兜底。
    function preferencePathMatches(candidate, target) {
        const left = normalizePreferencePath(candidate);
        const right = normalizePreferencePath(target);
        // 路径未知时一律拒绝匹配。旧实现这里返回 true（不否决），等于放任一个路径不明的
        // 快照套到当前模型上，会把别的模型的位置写过来。
        if (!left || !right) return false;
        if (left === right) return true;
        const leftCanonical = modelPathAliases.get(left);
        const rightCanonical = modelPathAliases.get(right);
        return !!leftCanonical && leftCanonical === rightCanonical;
    }

    // 模型加载完成、且本模块还没搬动它之前的位置。有偏好记录时它等于后端存的位置，
    // 没有记录时它等于默认布局，两种情况都正好是主页面会用的值。
    function captureLoadSnapshot() {
        const type = getActiveModelType();
        let record = null;

        if (type === 'live2d') {
            const manager = window.live2dManager;
            const model = manager && manager.currentModel;
            if (model && !model.destroyed && isUsablePosition({ x: model.x, y: model.y })) {
                record = {
                    path: String(manager._lastLoadedModelPath || ''),
                    position: { x: model.x, y: model.y }
                };
            }
        } else if (type === 'live3d') {
            const manager = live3dManager();
            const model = manager && manager.currentModel;
            const node = model && (getLive3DSubType() === 'mmd' ? model.mesh : model.scene);
            if (node && node.position && isUsablePosition(node.position) && Number.isFinite(node.position.z)) {
                record = {
                    path: String(model.url || ''),
                    position: { x: node.position.x, y: node.position.y, z: node.position.z }
                };
            }
        }

        if (!record) return;
        const existing = loadSnapshotByType.get(type);
        // 同一个模型重复就绪（Live2D 一次加载会连发两个就绪事件）时保留首次快照：
        // 第二次进来模型多半已被居中，覆盖会把「主页面会用的位置」换成临时居中位，
        // 首次保存（后端无记录）时就会把这个临时位置写进全局偏好。
        if (existing && String(existing.path || '') === String(record.path || '')) return;
        loadSnapshotByType.set(type, record);
    }

    // 返回 null 表示「没有可用的加载时快照」，此时调用方按原值传位置
    // （后端仍会用 preserve_position 兜住，不会让管理页的临时摆位落库）。
    function resolvePositionSubstitute(modelPath, incomingPosition) {
        const key = modelPath === undefined || modelPath === null ? '' : String(modelPath);

        // 用「模型加载完、本模块还没搬动它」那一刻的位置兜底 —— 那正好等于默认布局，
        // 也就是主页面会用的值；首次保存（后端还没有该模型记录）时就靠它建记录。
        for (const record of loadSnapshotByType.values()) {
            if (!record || !isUsablePosition(record.position, incomingPosition)) continue;
            if (!preferencePathMatches(record.path, key)) continue;   // 不是同一个模型宁可不换
            return { position: Object.assign({}, record.position) };
        }

        return null;
    }

    // 排查用开关：默认关闭，开启后每次位置写入都会打印明细。
    function isDebugEnabled() {
        try {
            return !!(window.localStorage && window.localStorage.getItem(DEBUG_FLAG_KEY) === '1');
        } catch (_) {
            return false;
        }
    }

    // 供运行时的 saveUserPreferences 调用：把一次位置写入标记为「后端保留已存位置」。
    // 返回值里的 preservePosition 会被运行时透传成请求体的 preserve_position；载荷里的
    // position/display/viewport 仍按本次入参给（有加载时快照就用快照位置兜底），供
    // 后端在「还没有该模型记录」时建立初始记录。
    // 本函数保证不抛异常——出任何意外都原样返回入参（preservePosition=false），
    // 绝不让保存因为它而失败。
    async function rewritePositionWrite(modelPath, position, display, viewport) {
        const fallback = { position, display, viewport, preservePosition: false };
        try {
            // 本模块只在管理页加载，这里再判一次页面类型，非管理页直接原样返回。
            if (!isMmPage() || stopped) return fallback;
            const substitute = resolvePositionSubstitute(modelPath, position);
            const resolvedPosition = substitute ? substitute.position : position;
            if (isDebugEnabled()) {
                console.log('[安全区] 位置写入改写', {
                    模型路径: modelPath,
                    本次要写的位置: position,
                    载荷位置: resolvedPosition,
                    来源: substitute ? '加载时快照' : '(无快照，按原值)',
                    保留后端位置: true,
                    快照: Array.from(loadSnapshotByType.values()).map((r) => r.path)
                });
            }
            return {
                position: resolvedPosition,
                display,
                viewport,
                preservePosition: true
            };
        } catch (error) {
            console.warn('[模型管理] 位置写入改写失败，改按原值保存:', error);
            return fallback;
        }
    }

    window.ModelManagerSafetyZone = {
        getModelScreenCenter,
        isModelReadyForActiveType,
        moveModelScreenBy,
        recenter: tryCenter,
        restoreOnLeave,
        clampAfterDrag,
        rewritePositionWrite,
        // 供页面在「同一次模型加载」里登记路径别名：持久化键（如 currentModelInfo.path）
        // 与实际加载用的配置 URL（如 model_config_url / _lastLoadedModelPath）指向同一模型。
        // 不登记的话，加载时快照的路径和保存时的路径可能对不上，隔离就会在首次建记录时漏掉。
        registerModelPathAlias
    };

    function install() {
        if (!isMmPage() || stopped) return;
        bindWindowHooks();
        startReadinessWatch();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', install, { once: true });
    } else {
        install();
    }
})();
