import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const {byteArray} = imports;

function assert(cond, msg) {
    if (!cond)
        throw new Error(`Assertion failed: ${msg}`);
}

function assertEqual(actual, expected, msg) {
    if (actual !== expected)
        throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function flushMainLoop(ms = 350) {
    const loop = GLib.MainLoop.new(null, false);
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        loop.quit();
        return GLib.SOURCE_REMOVE;
    });
    loop.run();
}

function makeWindow({
    id = 1,
    type = 0, // Meta.WindowType.NORMAL
    showing = true,
    skipTaskbar = false,
    workspace = null,
    rect = {x: 0, y: 1000, width: 500, height: 80},
    focused = false,
    canMinimize = true,
    overrideRedirect = false,
    attachedDialog = false,
} = {}, mocks) {
    const win = {
        _minimized: false,
        _activated: 0,
        _app: null,
        _iconGeometry: null,
        iconGeometryCalls: 0,
        get_id: () => id,
        get_icon_geometry: () => win._iconGeometry
            ? [true, win._iconGeometry]
            : [false, new mocks.Mtk.Rectangle()],
        set_icon_geometry: geometry => {
            win._iconGeometry = geometry;
            win.iconGeometryCalls++;
        },
        get_window_type: () => type,
        showing_on_its_workspace: () => showing,
        is_skip_taskbar: () => skipTaskbar,
        located_on_workspace: ws => ws === (workspace ?? mocks.env.activeWorkspace),
        get_frame_rect: () => rect,
        has_focus: () => focused,
        can_minimize: () => canMinimize,
        is_override_redirect: () => overrideRedirect,
        is_attached_dialog: () => attachedDialog,
        minimize: () => {
            win._minimized = true;
            win.minimizeCalls++;
        },
        activate: () => {
            win._activated++;
        },
        minimizeCalls: 0,
    };
    const actor = new mocks.MockActor({name: `window-${id}`});
    actor.meta_window = win;
    return {win, actor};
}

function makeAppIcon(windows, {
    state = 2, // Shell.AppState.RUNNING
    canOpenNewWindow = true,
} = {}, mocks) {
    const app = {
        state,
        activateCalls: 0,
        openNewWindowCalls: 0,
        activatedWindows: [],
        can_open_new_window: () => canOpenNewWindow,
        get_windows: () => windows,
        activate: () => {
            app.activateCalls++;
        },
        open_new_window: arg => {
            app.openNewWindowCalls++;
            app.lastOpenNewArg = arg;
        },
        activate_window: (win, time) => {
            app.activatedWindows.push({win, time});
        },
    };
    return {
        app,
        launchAnimations: 0,
        animateLaunch() {
            this.launchAnimations++;
        },
    };
}

function rewriteImports(source, mocksUrl) {
    for (const name of ['Clutter', 'Meta', 'Mtk', 'Pango', 'Shell', 'St']) {
        source = source.replace(
            `import ${name} from 'gi://${name}';`,
            `import {${name}} from '${mocksUrl}';`);
    }

    source = source.replace(
        /import \* as (Main|Dash|AppDisplay|BoxPointer|ModalDialog|PopupMenu) from 'resource:\/\/\/org\/gnome\/shell\/ui\/[^']+';/g,
        `import {$1} from '${mocksUrl}';`);

    return source.replace(
        `'resource:///org/gnome/shell/extensions/extension.js'`,
        `'${mocksUrl}'`);
}

async function loadExtension(repoRoot) {
    const mocksPath = GLib.build_filenamev([repoRoot, 'tests', 'mocks.js']);
    const mocksUrl = Gio.File.new_for_path(mocksPath).get_uri();
    const tmpDir = GLib.dir_make_tmp('muelle-test-XXXXXX');
    const files = ['extension.js', 'windowPreview.js'];

    try {
        for (const name of files) {
            const [, bytes] = Gio.File.new_for_path(
                GLib.build_filenamev([repoRoot, name])).load_contents(null);
            Gio.File.new_for_path(GLib.build_filenamev([tmpDir, name]))
                .replace_contents(
                    rewriteImports(byteArray.toString(bytes), mocksUrl),
                    null, false, Gio.FileCreateFlags.REPLACE_CREATION, null);
        }

        const mocks = await import(mocksUrl);
        const mod = await import(
            Gio.File.new_for_path(GLib.build_filenamev([tmpDir, 'extension.js'])).get_uri());
        return {MuelleExtension: mod.default, mocks};
    } finally {
        for (const name of files) {
            try {
                Gio.File.new_for_path(GLib.build_filenamev([tmpDir, name])).delete(null);
            } catch (_e) {
                // ignore cleanup errors
            }
        }
        try {
            Gio.File.new_for_path(tmpDir).delete(null);
        } catch (_e) {
            // ignore cleanup errors
        }
    }
}

const repoRoot = GLib.get_current_dir();
const schemaDir = GLib.build_filenamev([repoRoot, 'schemas']);
const {MuelleExtension, mocks} = await loadExtension(repoRoot);

const tests = [];
function test(name, fn) {
    tests.push({name, fn});
}

test('lifecycle: cleans up drag monitor, timers, signals, and avoids duplicate destroy', () => {
    mocks.resetEnv(schemaDir);
    const ext = new MuelleExtension({uuid: 'muelle@kenethriera'});
    ext.enable();

    const dock = ext._dock;
    assert(dock !== null, 'dock created on enable');
    assertEqual(mocks.env.oldDash.visible, false, 'native dash hidden');

    // Simulate active drag, pending tooltip timers, and pending auto-hide update
    mocks.env.Main.overview.emit('item-drag-begin');
    assertEqual(dock._dragging, true, 'dragging flag set');

    let timerCalls = 0;
    dock._showLabelTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
        timerCalls++;
        return GLib.SOURCE_REMOVE;
    });
    dock._resetHoverTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
        timerCalls++;
        return GLib.SOURCE_REMOVE;
    });
    dock._scheduleUpdate(50);
    assert(dock._updateTimeoutId > 0, 'update timer scheduled');

    const {actor: winActor} = makeWindow({}, mocks);
    mocks.env.windowActors.push(winActor);
    mocks.env.global.window_manager.emit('map', winActor);
    assert(dock._windowActors.has(winActor), 'window actor tracked');

    ext.disable();

    // #3: drag monitor cleaned via _endItemDrag()
    assertEqual(dock.endItemDragCalls, 1, '_endItemDrag called on disable');
    assertEqual(dock._dragging, false, '_dragging cleared');

    // #5: tooltip & update timers removed cleanly
    assertEqual(dock._showLabelTimeoutId, 0, '_showLabelTimeoutId zeroed');
    assertEqual(dock._resetHoverTimeoutId, 0, '_resetHoverTimeoutId zeroed');
    assertEqual(dock._updateTimeoutId, 0, '_updateTimeoutId zeroed');
    flushMainLoop(80);
    assertEqual(timerCalls, 0, 'cancelled tooltip timers never fire');

    // #9: _destroy() did not call super.destroy() a second time
    assertEqual(dock.destroyCalls, 1, 'destroy called exactly once');

    // #1: global & local signals disconnected; oldDash & AppIcon restored
    assertEqual(mocks.env.Main.overview.handlerCount(), 0, 'overview signals disconnected');
    assertEqual(mocks.env.global.display.handlerCount(), 0, 'display signals disconnected');
    assertEqual(mocks.env.global.window_manager.handlerCount(), 0, 'wm signals disconnected');
    assertEqual(mocks.env.global.workspace_manager.handlerCount(), 0, 'workspace signals disconnected');
    assertEqual(mocks.env.Main.layoutManager.handlerCount(), 0, 'layoutManager signals disconnected');
    assertEqual(winActor._muelleOwnedHandlers.length, 0, 'window actor signals disconnected');
    assertEqual(mocks.env.oldDash.visible, true, 'native dash shown again');
    assertEqual(mocks.env.oldDash.height, -1, 'native dash height reset');
    assertEqual(mocks.env.oldDash._maxHeight, -1, 'native dash _maxHeight reset');

    // Later events after disable do nothing
    mocks.env.global.display.emit('restacked');
    mocks.env.Main.overview.emit('item-drag-end');
    assertEqual(dock._updateTimeoutId, 0, 'disabled dock ignores later events');

    // Re-enable cycle succeeds cleanly
    ext.enable();
    assert(ext._dock !== null && ext._dock !== dock, 'new dock created on re-enable');
    ext.disable();
});

test('lifecycle: shutdown destroying oldDash and dock before disable() is safe', () => {
    mocks.resetEnv(schemaDir);
    const ext = new MuelleExtension({uuid: 'muelle@kenethriera'});
    ext.enable();

    const dock = ext._dock;
    mocks.env.oldDash.destroy();
    dock.destroy();
    assertEqual(ext._dock, null, 'ext._dock cleared when dock destroyed by shell');

    ext.disable(); // must not throw
    assertEqual(dock.destroyCalls, 1, 'dock not destroyed twice');
});

test('auto-hide: drag end re-evaluates visibility (#12) and resize recalculates overlap (#13)', () => {
    mocks.resetEnv(schemaDir);
    mocks.env.settings.set_string('autohide-mode', 'on');
    const ext = new MuelleExtension({uuid: 'muelle@kenethriera'});
    ext.enable();

    const dock = ext._dock;
    assertEqual(dock._hidden, true, 'starts hidden in on mode');
    assertEqual(dock.visible, false, 'actor hidden in on mode');

    // Reveal via strip hover, start drag, leave strip, end drag
    dock._revealStrip.emit('enter-event');
    assertEqual(dock._hidden, false, 'revealed on strip enter');
    assertEqual(dock.visible, true, 'actor shown on reveal');

    mocks.env.Main.overview.emit('item-drag-begin');
    dock._revealStrip.emit('leave-event');
    flushMainLoop(340);
    assertEqual(dock._hidden, false, 'stays visible while dragging');

    mocks.env.Main.overview.emit('item-drag-end');
    assertEqual(dock._dragging, false, 'drag ended');
    assert(dock._updateTimeoutId > 0, 'update scheduled after drag end');
    flushMainLoop(340);
    assertEqual(dock._hidden, true, 'hides after drag ends (#12)');
    assertEqual(dock.visible, false, 'actor hidden again after slide out');

    // Switch to intelligent mode and verify dock resize recalculates overlap (#13)
    mocks.env.settings.set_string('autohide-mode', 'intelligent');
    const {actor: nearActor} = makeWindow({
        rect: {x: 0, y: 990, width: 500, height: 30}, // bottom=1020, dockTop=1080-64=1016 (overlaps if height=64, not if 32)
    }, mocks);
    mocks.env.windowActors.push(nearActor);

    // Shrink icon/dock height so window no longer overlaps, then notify height
    dock._preferredHeight = 32;
    dock.set_height(32);
    flushMainLoop(340);
    assertEqual(dock._hidden, false, 'visible when height shrinks below overlap');

    // Grow dock height back to 64 so window overlaps again
    dock._preferredHeight = 64;
    dock.height = 64;
    dock.emit('icon-size-changed');
    flushMainLoop(340);
    assertEqual(dock._hidden, true, 'hidden when height grows into overlap (#13)');

    ext.disable();
});

test('icon size: defaults to 64, resizes existing icons, and 0 delegates to Dash', () => {
    mocks.resetEnv(schemaDir);
    assertEqual(mocks.env.settings.get_int('dock-icon-size'), 64, 'default icon size is the current value');

    const ext = new MuelleExtension({uuid: 'muelle@kenethriera'});
    ext.enable();

    const dock = ext._dock;
    const resized = [];
    dock._box = {
        get_children: () => [{
            child: {
                _delegate: {
                    icon: {setIconSize: size => resized.push(size)},
                },
            },
        }],
    };
    dock._showAppsIcon = {
        icon: {setIconSize: size => resized.push(size)},
    };

    mocks.env.settings.set_int('dock-icon-size', 48);
    flushMainLoop(20);
    assertEqual(dock.iconSize, 48, 'fixed icon size applied');
    assertEqual(resized.length, 2, 'app and Show Apps icons resized');
    assert(resized.every(size => size === 48), 'all icons use the new size');

    const settings = dock._settings;
    dock._settings = {get_int: () => 0};
    dock._adjustIconSize();
    dock._settings = settings;
    assertEqual(dock.autoAdjustCalls, 1, 'legacy 0 delegates to the native Dash');

    ext.disable();
});

test('dock width: animates growth and shrink, then restores natural sizing', () => {
    mocks.resetEnv(schemaDir);
    const ext = new MuelleExtension({uuid: 'muelle@kenethriera'});
    ext.enable();

    const dock = ext._dock;
    const box = {
        _width: 400,
        _natural: 400,
        eases: [],
        get_width() {
            return this._width;
        },
        set_width(w) {
            this._width = w < 0 ? this._natural : w;
        },
        remove_all_transitions() {},
        get_preferred_width() {
            return [0, this._natural];
        },
        ease(params) {
            this.eases.push(params);
            this._width = params.width;
            params.onStopped?.();
        },
    };
    dock._box = box;

    // Adding an app widens the box.
    box._natural = 480;
    dock._redisplay();
    assertEqual(box.eases.length, 1, 'width animated when growing');
    assertEqual(box.eases[0].width, 480, 'grows to the new natural width');
    assertEqual(box.eases[0].duration, 150, 'uses the dock animation time');
    assertEqual(box._width, 480, 'natural sizing restored after the animation');

    // Removing it shrinks the box.
    box._natural = 400;
    dock._redisplay();
    assertEqual(box.eases.length, 2, 'width animated when shrinking');
    assertEqual(box.eases[1].width, 400, 'shrinks to the new natural width');

    // No layout change: no animation.
    dock._redisplay();
    assertEqual(box.eases.length, 2, 'no animation without a width change');

    // The overview keeps its native item animations only.
    mocks.env.overviewVisible = true;
    box._natural = 480;
    dock._redisplay();
    assertEqual(box.eases.length, 2, 'no width animation in the overview');

    ext.disable();
});

test('dock items: keep their natural width while the dock animates', () => {
    mocks.resetEnv(schemaDir);
    const ext = new MuelleExtension({uuid: 'muelle@kenethriera'});
    ext.enable();

    const item = ext._dock._createAppItem({});
    assertEqual(item.x_expand, false,
        'dock items do not expand horizontally');

    ext.disable();
});

test('trash: setting toggles the item and the icon reflects the trash state', () => {
    mocks.resetEnv(schemaDir);
    assertEqual(mocks.env.settings.get_boolean('show-trash'), true,
        'trash shown by default');

    const ext = new MuelleExtension({uuid: 'muelle@kenethriera'});
    ext.enable();

    const dock = ext._dock;
    assert(dock._trashItem !== null, 'trash item created');
    assertEqual(dock._trashItem.visible, true, 'trash item visible');
    assertEqual(dock._trashSeparator.visible, true, 'trash separator visible');

    mocks.env.settings.set_boolean('show-trash', false);
    flushMainLoop(20);
    assertEqual(dock._trashItem.visible, false, 'trash hidden by setting');
    assertEqual(dock._trashSeparator.visible, false, 'separator hidden by setting');

    mocks.env.settings.set_boolean('show-trash', true);
    flushMainLoop(20);
    assertEqual(dock._trashItem.visible, true, 'trash restored by setting');

    dock._trash = {query_info: () => ({get_attribute_uint32: () => 2})};
    dock._updateTrash();
    assertEqual(dock._trashItem._icon.icon_name, 'user-trash-full',
        'full icon when trash has items');
    assertEqual(dock._emptyTrashMenuItem.sensitive, true,
        'empty action enabled when trash has items');

    dock._trash = {query_info: () => ({get_attribute_uint32: () => 0})};
    dock._updateTrash();
    assertEqual(dock._trashItem._icon.icon_name, 'user-trash',
        'empty icon when trash is empty');
    assertEqual(dock._emptyTrashMenuItem.sensitive, false,
        'empty action disabled when trash is empty');

    dock._emptyTrash();
    assert(dock._emptyTrashDialog !== null, 'confirmation dialog opened');
    assertEqual(dock._emptyTrashDialog.buttons.length, 2,
        'confirmation dialog has two actions');
    assertEqual(dock._emptyTrashDialog.buttons[0].default, true,
        'cancel is the default action');
    dock._emptyTrashDialog.close();
    assertEqual(dock._emptyTrashDialog, null, 'dialog cleared on close');

    ext.disable();
});

test('overlap: dialogs trigger auto-hide (#6) and Show Desktop hidden windows do not (#11)', () => {
    mocks.resetEnv(schemaDir);
    mocks.env.settings.set_string('autohide-mode', 'intelligent');
    const ext = new MuelleExtension({uuid: 'muelle@kenethriera'});
    ext.enable();

    const dock = ext._dock;
    assertEqual(dock._hidden, false, 'visible with no windows');

    // Dialog overlapping dock triggers hide (#6)
    const {win: dlgWin, actor: dlgActor} = makeWindow({
        id: 10,
        type: mocks.Meta.WindowType.MODAL_DIALOG,
        showing: true,
        rect: {x: 100, y: 1030, width: 300, height: 60},
    }, mocks);
    mocks.env.windowActors.push(dlgActor);
    mocks.env.global.display.emit('restacked');
    flushMainLoop(340);
    assertEqual(dock._hidden, true, 'modal dialog hides dock in intelligent mode (#6)');

    // Show Desktop hides windows (showing_on_its_workspace() === false) (#11)
    dlgWin.showing_on_its_workspace = () => false;
    mocks.env.global.workspace_manager.emit('showing-desktop-changed');
    flushMainLoop(340);
    assertEqual(dock._hidden, false, 'dock shows when Show Desktop hides windows (#11)');

    // Skip-taskbar windows are ignored
    const {actor: skipActor} = makeWindow({
        id: 11,
        type: mocks.Meta.WindowType.DIALOG,
        showing: true,
        skipTaskbar: true,
        rect: {x: 100, y: 1030, width: 300, height: 60},
    }, mocks);
    mocks.env.windowActors.push(skipActor);
    mocks.env.global.display.emit('restacked');
    flushMainLoop(340);
    assertEqual(dock._hidden, false, 'skip-taskbar window ignored');

    ext.disable();
});

test('minimize: windows target their dock icon and restore geometry', () => {
    mocks.resetEnv(schemaDir);
    const ext = new MuelleExtension({uuid: 'muelle@kenethriera'});
    ext.enable();

    const dock = ext._dock;
    const app = {get_id: () => 'test.app'};
    const icon = new mocks.MockActor({name: 'app-icon'});
    icon.set_position(100, 200);
    icon.set_size(64, 64);
    dock._box = {
        get_children: () => [{child: {app, icon: {icon}}}],
    };

    const {win, actor} = makeWindow({id: 40}, mocks);
    win._app = app;
    win._iconGeometry = new mocks.Mtk.Rectangle(
        {x: 1, y: 2, width: 3, height: 4});
    mocks.env.windowActors.push(actor);

    dock._updateMinimizeGeometry();
    assertEqual(win._iconGeometry.x, 100, 'minimize target x');
    assertEqual(win._iconGeometry.y, 200, 'minimize target y');
    assertEqual(win._iconGeometry.width, 64, 'minimize target width');
    assertEqual(win._iconGeometry.height, 64, 'minimize target height');

    ext.disable();
    assertEqual(win._iconGeometry.x, 1, 'original geometry x restored');
    assertEqual(win._iconGeometry.y, 2, 'original geometry y restored');
    assertEqual(win._iconGeometry.width, 3, 'original geometry width restored');
    assertEqual(win._iconGeometry.height, 4, 'original geometry height restored');
});

test('click: single-window app activates in overview (#4) and caches workspace (#8)', () => {
    mocks.resetEnv(schemaDir);
    const ext = new MuelleExtension({uuid: 'muelle@kenethriera'});
    ext.enable();

    const {win: focusedWin} = makeWindow({id: 1, focused: true, canMinimize: true}, mocks);
    const {win: unminimizableWin} = makeWindow({id: 2, focused: true, canMinimize: false}, mocks);

    // #4: in overview, clicking single focused window activates & closes overview, does NOT minimize
    mocks.env.overviewVisible = true;
    const icon1 = makeAppIcon([focusedWin], {}, mocks);
    mocks.AppDisplay.AppIcon.prototype.activate.call(icon1, 1);
    assertEqual(focusedWin.minimizeCalls, 0, 'focused window not minimized from overview');
    assertEqual(icon1.app.activateCalls, 1, 'app activated from overview');
    assertEqual(mocks.env.Main.overview.hideCalls, 1, 'overview closed');

    mocks.env.overviewVisible = true;
    const iconUnmin = makeAppIcon([unminimizableWin], {}, mocks);
    mocks.AppDisplay.AppIcon.prototype.activate.call(iconUnmin, 1);
    assertEqual(iconUnmin.app.activateCalls, 1, 'unminimizable app activated from overview');
    assertEqual(mocks.env.Main.overview.hideCalls, 2, 'overview closed for unminimizable window');

    // Outside overview: single focused minimizable window minimizes
    mocks.env.overviewVisible = false;
    mocks.AppDisplay.AppIcon.prototype.activate.call(icon1, 1);
    assertEqual(focusedWin.minimizeCalls, 1, 'focused window minimized outside overview');

    // Outside overview: multi-window app cycles and looks up active workspace once (#8)
    const {win: wA} = makeWindow({id: 10, focused: true}, mocks);
    const {win: wB} = makeWindow({id: 20, focused: false}, mocks);
    const {win: wC} = makeWindow({id: 30, focused: false}, mocks);
    const multiIcon = makeAppIcon([wA, wB, wC], {}, mocks);
    mocks.env.workspaceLookupCount = 0;
    mocks.AppDisplay.AppIcon.prototype.activate.call(multiIcon, 1);
    assertEqual(mocks.env.workspaceLookupCount, 1, 'active workspace queried once per click (#8)');
    assertEqual(multiIcon.app.activatedWindows.length, 1, 'next window activated');
    assertEqual(multiIcon.app.activatedWindows[0].win, wB, 'cycled to next window');

    ext.disable();
});

test('preview: open preview keeps the dock shown and is torn down', () => {
    mocks.resetEnv(schemaDir);
    mocks.env.settings.set_string('autohide-mode', 'on');
    const originalTooltip = mocks.AppDisplay.AppIcon.prototype.shouldShowTooltip;

    const ext = new MuelleExtension({uuid: 'muelle@kenethriera'});
    ext.enable();

    const dock = ext._dock;
    assert(ext._preview !== null, 'preview created on enable');
    assert(mocks.AppDisplay.AppIcon.prototype.shouldShowTooltip !== originalTooltip,
        'dash tooltip suppressed while previewing');

    const icon = new mocks.Dash.DashIcon();
    icon.app = {get_windows: () => [{is_skip_taskbar: () => false}]};
    assertEqual(mocks.AppDisplay.AppIcon.prototype.shouldShowTooltip.call(icon), false,
        'tooltip hidden for icons with previewable windows');
    icon.app = {get_windows: () => [{is_skip_taskbar: () => true}]};
    assertEqual(mocks.AppDisplay.AppIcon.prototype.shouldShowTooltip.call(icon), true,
        'tooltip kept for icons without previewable windows');

    assertEqual(dock._hidden, true, 'dock hidden without hover');

    dock.setPreviewOpen(true);
    assertEqual(dock._shouldShow(), true, 'dock shown while the preview is open');
    assertEqual(dock._hidden, false, 'dock slides in with the preview open');

    dock.setPreviewOpen(false);
    assert(dock._updateTimeoutId > 0, 'visibility re-evaluated after the preview closes');
    flushMainLoop(340);
    assertEqual(dock._hidden, true, 'dock hides again once the preview is closed');

    const popup = ext._preview._popup;
    ext.disable();
    assertEqual(ext._preview, null, 'preview cleared on disable');
    assertEqual(mocks.AppDisplay.AppIcon.prototype.shouldShowTooltip, originalTooltip,
        'dash tooltip restored on disable');
    assert(mocks.env.removedChrome.includes(popup),
        'preview popup removed from chrome');
    assertEqual(dock._hidden, true, 'preview teardown does not reveal the dock');
});

test('preview: thumbnails shrink to fit and never collapse', () => {
    mocks.resetEnv(schemaDir);
    const ext = new MuelleExtension({uuid: 'muelle@kenethriera'});
    ext.enable();

    const preview = ext._preview;
    const icon = new mocks.Dash.DashIcon();
    icon.app = {get_name: () => 'Test', get_windows: () => []};

    const windowsFor = count => Array.from({length: count}, (_, index) => ({
        get_title: () => `Window ${index}`,
        get_compositor_private: () => ({get_size: () => [1600, 900]}),
    }));

    const thumbWidth = count => {
        preview.show(icon, windowsFor(count));
        const row = preview._content.get_children()[1];
        const item = row.get_children()[0];
        return item.child.get_children()[0].get_width();
    };

    assertEqual(thumbWidth(3), 200, 'full width for a few windows');
    assertEqual(thumbWidth(10), 169, 'shrinks to fit with ten windows');
    assertEqual(thumbWidth(300), 96, 'never collapses below 96px');

    ext.disable();
});

test('preview: opens only when the pointer moves', () => {
    mocks.resetEnv(schemaDir);
    const ext = new MuelleExtension({uuid: 'muelle@kenethriera'});
    ext.enable();

    const preview = ext._preview;
    GLib.Source.remove(preview._pollId);
    preview._pollId = 0;

    const icon = new mocks.MockActor({name: 'icon'});
    icon._delegate = {app: {get_name: () => 'Test', get_windows: () => []}};
    ext._dock.add_child(icon);

    let position = [10, 10];
    mocks.env.global.get_pointer = () => position;
    mocks.env.global.stage.get_actor_at_pos = () => icon;
    preview._pointer = [10, 10];

    preview._poll();
    assertEqual(preview._showId, 0, 'resting cursor does not open the preview');

    position = [11, 10];
    preview._poll();
    assert(preview._showId > 0, 'moving the cursor schedules the preview');

    preview._cancelShow();
    ext.disable();
});

let failed = 0;
for (const t of tests) {
    try {
        t.fn();
        print(`PASS: ${t.name}`);
    } catch (e) {
        failed++;
        printerr(`FAIL: ${t.name}\n  ${e.stack || e.message}`);
    }
}

print(`\n${tests.length - failed}/${tests.length} tests passed`);
if (failed > 0)
    imports.system.exit(1);
