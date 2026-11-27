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
        'clicked': {},
        'popup-menu': {},
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
        this.mapped = true;
        this.opacity = props.opacity ?? 255;
        this.name = props.name ?? '';
        this.destroyCalls = 0;
        this.hideCalls = 0;
        this.showCalls = 0;
        this.transitionsRemoved = 0;
        this.eases = [];
        this.clutter_text = {
            ellipsize: 0,
            single_line_mode: false,
            line_wrap: false,
        };
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

    set_child(child) {
        this.child = child;
    }

    add_child(child) {
        if (!this._children)
            this._children = [];
        this._children.push(child);
        child._parent = this;
    }

    remove_child(child) {
        const index = this._children ? this._children.indexOf(child) : -1;
        if (index !== -1)
            this._children.splice(index, 1);
    }

    get_children() {
        return [...(this._children ?? [])];
    }

    set_child_at_index(child, index) {
        if (!this._children)
            this._children = [];
        const current = this._children.indexOf(child);
        if (current !== -1)
            this._children.splice(current, 1);
        if (index < 0 || index >= this._children.length)
            this._children.push(child);
        else
            this._children.splice(index, 0, child);
    }

    add_action(_action) {
    }

    set_style(_style) {
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

    get_transformed_position() {
        return [this._x, this._y];
    }

    get_transformed_size() {
        return [this._width, this.height];
    }

    get_width() {
        return this._width;
    }

    get_height() {
        return this.height;
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
        this._parent?.remove_child(this);
        this._parent = null;
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
        this.iconSize = 64;
        this._maxWidth = -1;
        this._maxHeight = -1;
        this.autoAdjustCalls = 0;
        this._workId = 1;
        this._showLabelTimeoutId = 0;
        this._resetHoverTimeoutId = 0;
        this.endItemDragCalls = 0;
    }

    _adjustIconSize() {
        this.autoAdjustCalls++;
    }

    _hookUpLabel(_item) {
    }

    setMaxSize(_w, h) {
        this._maxHeight = h;
    }

    _endItemDrag() {
        this.endItemDragCalls++;
    }

    _redisplay() {
    }
});

export const MockDashItemContainer = GObject.registerClass(
class MockDashItemContainer extends MockActor {
    _init() {
        super._init();
        this.child = null;
        this._labelText = '';
    }

    setChild(child) {
        this.child = child;
    }

    setLabelText(text) {
        this._labelText = text;
    }

    show() {
    }

    showLabel() {
    }

    hideLabel() {
    }
});

// Provide GObject-backed classes/APIs expected by extension.js
export const Clutter = {
    BUTTON_MIDDLE: 2,
    BUTTON_SECONDARY: 3,
    ModifierType: {CONTROL_MASK: 1 << 2},
    AnimationMode: {EASE_OUT_QUAD: 1, EASE_IN_QUAD: 2},
    ActorAlign: {CENTER: 0, START: 1, END: 2},
    PickMode: {REACTIVE: 1},
    Orientation: {HORIZONTAL: 0, VERTICAL: 1},
    KEY_Escape: 65307,
    EVENT_PROPAGATE: 0,
    EVENT_STOP: 1,
    BinLayout: class {
    },
    Clone: MockActor,
    ClickGesture: class {
        constructor() {
        }

        connect() {
        }
    },
    get_current_event: () => env.currentEvent,
};

export const Pango = {
    EllipsizeMode: {NONE: 0, START: 1, MIDDLE: 2, END: 3},
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
    WindowTracker: {
        get_default: () => ({
            get_window_app: window => window._app ?? null,
        }),
    },
};

export const Mtk = {
    Rectangle: class Rectangle {
        constructor({x = 0, y = 0, width = 0, height = 0} = {}) {
            Object.assign(this, {x, y, width, height});
        }
    },
};

export const St = {
    Widget: MockActor,
    Bin: MockActor,
    Button: MockActor,
    Icon: MockActor,
    Label: MockActor,
    BoxLayout: MockActor,
    Side: {TOP: 0, BOTTOM: 1, LEFT: 2, RIGHT: 3},
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
            shouldShowTooltip() {
                return true;
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
        uiGroup: new MockActor({name: 'uiGroup'}),
        notify: () => {},
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
    g.stage = new SimpleEmitter('stage');
    g.stage.get_actor_at_pos = () => null;
    g.get_pointer = () => [0, 0];
    g.get_window_actors = () => env.windowActors;
    g.get_current_time = () => 12345;
    env.global = g;
    globalThis.global = g;

    AppDisplay.AppIcon.prototype.activate = function originalActivate(button) {
        env.originalActivateCalls.push({icon: this, button});
    };
    AppDisplay.AppIcon.prototype.shouldShowTooltip = function() {
        return true;
    };
}

export const Main = new Proxy({}, {
    get(_t, prop) {
        return env.Main[prop];
    },
});

class MockPopupMenu extends SimpleEmitter {
    constructor(_sourceActor) {
        super('popup-menu');
        this.actor = new MockActor({name: 'popup-menu'});
        this.menuItems = [];
    }

    addMenuItem(item) {
        this.menuItems.push(item);
    }

    toggle() {
    }

    close() {
    }

    destroy() {
        this.actor.destroy();
    }
}

class MockPopupMenuItem extends SimpleEmitter {
    constructor(label) {
        super('popup-menu-item');
        this.label = label;
        this.sensitive = true;
    }

    setSensitive(sensitive) {
        this.sensitive = sensitive;
    }
}

class MockPopupMenuManager {
    constructor(_owner) {
    }

    addMenu(menu) {
        this.menu = menu;
    }
}

export const PopupMenu = {
    PopupMenu: MockPopupMenu,
    PopupMenuItem: MockPopupMenuItem,
    PopupMenuManager: MockPopupMenuManager,
};

class MockModalDialog extends SimpleEmitter {
    constructor() {
        super('modal-dialog');
        this.contentLayout = new MockActor({name: 'modal-dialog-content'});
        this.buttons = [];
    }

    addButton(info) {
        this.buttons.push(info);
    }

    open() {
    }

    close() {
        this.emit('closed');
    }

    destroy() {
    }
}

export const ModalDialog = {
    ModalDialog: MockModalDialog,
};

export const Dash = {
    Dash: MockDash,
    DashItemContainer: MockDashItemContainer,
    DashIcon: MockActor,
};

const MockBoxPointer = GObject.registerClass(
class MockBoxPointer extends MockActor {
    _init() {
        super._init({name: 'box-pointer'});
        this.bin = new MockActor({name: 'box-pointer-bin'});
        this.arrowSide = St.Side.BOTTOM;
    }

    add_style_class_name(_name) {
    }

    setPosition(_sourceActor, _alignment) {
    }

    queue_relayout() {
    }

    contains(_actor) {
        return false;
    }

    open(_animate) {
        this.visible = true;
    }

    close(_animate, onComplete) {
        this.visible = false;
        if (onComplete)
            onComplete();
    }
});

export const BoxPointer = {
    BoxPointer: MockBoxPointer,
    PopupAnimation: {NONE: 0, SLIDE: 1, FADE: 2, FULL: ~0},
};
