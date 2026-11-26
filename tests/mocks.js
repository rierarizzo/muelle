import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

const _signalHosts = new Set();

function attachConnectObject(proto) {
    proto.connectObject = function (...args) {
        if (args.length < 3 || args.length % 2 === 0)
            throw new Error(`Invalid connectObject arguments (${args.length})`);

        const owner = args[args.length - 1];
        if (!this._muelleOwnedHandlers)
            this._muelleOwnedHandlers = [];
        _signalHosts.add(this);

        for (let i = 0; i < args.length - 1; i += 2) {
            const signal = args[i];
            const callback = args[i + 1];
            const id = this.connect(signal, callback);
            this._muelleOwnedHandlers.push({owner, signal, id});
        }
    };

    proto.disconnectObject = function (owner) {
        if (!this._muelleOwnedHandlers)
            return;

        const remaining = [];
        for (const entry of this._muelleOwnedHandlers) {
            if (entry.owner === owner)
                this.disconnect(entry.id);
            else
                remaining.push(entry);
        }
        this._muelleOwnedHandlers = remaining;
    };
}

export class SimpleEmitter {
    constructor(name = 'emitter') {
        this._name = name;
        this._nextId = 1;
        this._handlers = new Map();
        this._muelleOwnedHandlers = [];
    }

    connect(signal, callback) {
        const id = this._nextId++;
        if (!this._handlers.has(signal))
            this._handlers.set(signal, new Map());
        this._handlers.get(signal).set(id, callback);
        return id;
    }

    disconnect(id) {
        for (const map of this._handlers.values()) {
            if (map.delete(id))
                return;
        }
    }

    emit(signal, ...args) {
        const map = this._handlers.get(signal);
        if (!map)
            return;
        for (const cb of [...map.values()])
            cb(this, ...args);
    }

    handlerCount(signal = null) {
        if (signal)
            return this._handlers.get(signal)?.size ?? 0;
        let total = 0;
        for (const map of this._handlers.values())
            total += map.size;
        return total;
    }
}
attachConnectObject(SimpleEmitter.prototype);

export const MockActor = GObject.registerClass({
    Properties: {
        'checked': GObject.ParamSpec.boolean(
            'checked', 'checked', 'checked',
            GObject.ParamFlags.READWRITE, false),
        'height': GObject.ParamSpec.double(
            'height', 'height', 'height',
            GObject.ParamFlags.READWRITE, -1, 10000, 48),
        'hover': GObject.ParamSpec.boolean(
            'hover', 'hover', 'hover',
            GObject.ParamFlags.READWRITE, false),
        'visible': GObject.ParamSpec.boolean(
            'visible', 'visible', 'visible',
            GObject.ParamFlags.READWRITE, true),
    },
    Signals: {
        'destroy': {},
        'enter-event': {},
        'leave-event': {},
        'scroll-event': {param_types: [GObject.TYPE_POINTER]},
    },
}, class MockActor extends GObject.Object {
    _init(props = {}) {
        super._init();
        this._destroyed = false;
        this._hover = false;
        this._reactive = false;
        this._trackHover = false;
        this._x = 0;
        this._y = 0;
        this._width = 0;
        this._preferredHeight = 64;
        this.translation_y = 0;
        this.opacity = props.opacity ?? 255;
        this.name = props.name ?? '';
        this.destroyCalls = 0;
        this.hideCalls = 0;
        this.showCalls = 0;
        this.transitionsRemoved = 0;
        this.eases = [];
    }

    set_track_hover(v) {
        this._trackHover = v;
    }

    set_reactive(v) {
        this._reactive = v;
    }

    set_hover(v) {
        this.hover = v;
    }

    get_hover() {
        return this.hover;
    }

    show() {
        this.visible = true;
        this.showCalls++;
    }

    hide() {
        this.visible = false;
        this.hideCalls++;
    }

    set_height(h) {
        this.height = h;
    }

    set_width(w) {
        this._width = w;
    }

    set_position(x, y) {
        this._x = x;
        this._y = y;
    }

    set_size(w, h) {
        this._width = w;
        this.height = h;
    }

    get_preferred_height(_forWidth) {
        return [this._preferredHeight, this._preferredHeight];
    }

    get_stage() {
        return env.hasStage ? {} : null;
    }

    remove_all_transitions() {
        this.transitionsRemoved++;
    }

    ease(params) {
        this.eases.push(params);
        if (params.translation_y !== undefined)
            this.translation_y = params.translation_y;
        if (env.completeAnimationsImmediately && params.onStopped)
            params.onStopped();
    }

    destroy() {
        this.destroyCalls++;
        if (this._destroyed)
            return;
        this._destroyed = true;
        this.emit('destroy');
    }
});
attachConnectObject(MockActor.prototype);

export const MockDash = GObject.registerClass({
    Signals: {
        'icon-size-changed': {},
    },
}, class MockDash extends MockActor {
    _init() {
        super._init();
        this._dashContainer = new MockActor({name: 'dashContainer'});
        this.showAppsButton = new MockActor({name: 'showAppsButton'});
        this._maxHeight = -1;
        this._workId = 1;
        this._showLabelTimeoutId = 0;
        this._resetHoverTimeoutId = 0;
        this.endItemDragCalls = 0;
    }

    setMaxSize(_w, h) {
        this._maxHeight = h;
    }

    _endItemDrag() {
        this.endItemDragCalls++;
    }
});

// Provide GObject-backed classes/APIs expected by extension.js
export const Clutter = {
    BUTTON_MIDDLE: 2,
    ModifierType: {CONTROL_MASK: 1 << 2},
    AnimationMode: {EASE_OUT_QUAD: 1, EASE_IN_QUAD: 2},
    get_current_event: () => env.currentEvent,
};

export const Meta = {
    WindowType: {
        NORMAL: 0,
        DESKTOP: 1,
        DOCK: 2,
        DIALOG: 3,
        MODAL_DIALOG: 4,
    },
};

export const Shell = {
    AppState: {STOPPED: 0, STARTING: 1, RUNNING: 2},
};

export const St = {
    Widget: MockActor,
};

// Re-export real GLib and GObject so extension.js uses genuine timers & classes
export {GLib, GObject};

export class Extension {
    constructor(metadata) {
        this.metadata = metadata;
    }

    getSettings() {
        return env.settings;
    }
}

export const AppDisplay = {
    AppIcon: {
        prototype: {
            activate: function originalActivate(button) {
                env.originalActivateCalls.push({icon: this, button});
            },
        },
    },
};

export const env = {
    hasStage: true,
    completeAnimationsImmediately: true,
    currentEvent: null,
    settings: null,
    originalActivateCalls: [],
    queuedDeferredWorks: [],
    chromeCalls: [],
    removedChrome: [],
    windowActors: [],
    activeWorkspace: {id: 'ws-1'},
    workspaceLookupCount: 0,
    primaryIndex: 0,
    primaryMonitor: {x: 0, y: 0, width: 1920, height: 1080},
    workArea: {x: 0, y: 32, width: 1920, height: 1048},
    overviewVisible: false,
    oldDash: null,
    Main: null,
    global: null,
};

export function resetEnv(schemaDir) {
    _signalHosts.clear();
    env.hasStage = true;
    env.completeAnimationsImmediately = true;
    env.currentEvent = null;
    env.originalActivateCalls = [];
    env.queuedDeferredWorks = [];
    env.chromeCalls = [];
    env.removedChrome = [];
    env.windowActors = [];
    env.activeWorkspace = {id: 'ws-1'};
    env.workspaceLookupCount = 0;
    env.primaryIndex = 0;
    env.primaryMonitor = {x: 0, y: 0, width: 1920, height: 1080};
    env.workArea = {x: 0, y: 32, width: 1920, height: 1048};
    env.overviewVisible = false;

    const schemaSource = Gio.SettingsSchemaSource.new_from_directory(
        schemaDir, Gio.SettingsSchemaSource.get_default(), false);
    const schema = schemaSource.lookup('org.gnome.shell.extensions.muelle', false);
    const backend = Gio.memory_settings_backend_new();
    const settings = new Gio.Settings({
        settings_schema: schema,
        backend,
    });
    attachConnectObject(settings);
    env.settings = settings;

    const oldDash = new MockDash();
    env.oldDash = oldDash;

    const overview = new SimpleEmitter('overview');
    Object.defineProperty(overview, 'visible', {
        get: () => env.overviewVisible,
        set: v => { env.overviewVisible = v; },
    });
    overview.dash = oldDash;
    overview.hideCalls = 0;
    overview.showAppsCalls = 0;
    overview.hide = () => {
        env.overviewVisible = false;
        overview.hideCalls++;
    };
    overview.showApps = () => {
        overview.showAppsCalls++;
    };

    const layoutManager = new SimpleEmitter('layoutManager');
    Object.defineProperty(layoutManager, 'primaryIndex', {
        get: () => env.primaryIndex,
    });
    Object.defineProperty(layoutManager, 'primaryMonitor', {
        get: () => env.primaryMonitor,
    });
    layoutManager.getWorkAreaForMonitor = idx =>
        idx === env.primaryIndex ? env.workArea : null;
    layoutManager.addTopChrome = (actor, params = {}) => {
        env.chromeCalls.push({op: 'addTopChrome', actor, params});
    };
    layoutManager.removeChrome = actor => {
        env.removedChrome.push(actor);
    };
    layoutManager.untrackChrome = actor => {
        env.chromeCalls.push({op: 'untrackChrome', actor});
    };
    layoutManager.trackChrome = (actor, params = {}) => {
        env.chromeCalls.push({op: 'trackChrome', actor, params});
    };

    const wm = {
        handleWorkspaceScroll: () => {},
    };

    env.Main = {
        overview,
        layoutManager,
        wm,
        queueDeferredWork: id => env.queuedDeferredWorks.push(id),
    };

    const display = new SimpleEmitter('display');
    const windowManager = new SimpleEmitter('window_manager');
    const workspaceManager = new SimpleEmitter('workspace_manager');
    workspaceManager.get_active_workspace = () => {
        env.workspaceLookupCount++;
        return env.activeWorkspace;
    };

    const g = new SimpleEmitter('global');
    g.display = display;
    g.window_manager = windowManager;
    g.workspace_manager = workspaceManager;
    g.get_window_actors = () => env.windowActors;
    g.get_current_time = () => 12345;
    env.global = g;
    globalThis.global = g;

    AppDisplay.AppIcon.prototype.activate = function originalActivate(button) {
        env.originalActivateCalls.push({icon: this, button});
    };
}

export const Main = new Proxy({}, {
    get(_t, prop) {
        return env.Main[prop];
    },
});

export const Dash = {
    Dash: MockDash,
};
