// Minimal stand-ins for the GNOME Shell / St / Clutter modules that
// selection.js imports, so its lifecycle can be exercised without a session.

export const log = [];

export class EventEmitter {
    constructor() {
        this._connections = new Map();
        this._nextId = 1;
        this.disconnectAllCalls = 0;
    }

    connect(name, callback) {
        const id = this._nextId++;
        this._connections.set(id, {name, callback, disconnected: false});
        return id;
    }

    disconnect(id) {
        const connection = this._connections.get(id);
        if (!connection)
            throw new Error(`No signal connection ${id} found`);
        if (connection.disconnected)
            throw new Error(`Signal handler id ${id} already disconnected`);
        connection.disconnected = true;
        this._connections.delete(id);
    }

    emit(name, ...args) {
        // snapshot, like gjs' _signals.js, so handlers may disconnect themselves
        const handlers = [...this._connections.values()].filter(c => c.name === name);
        for (const handler of handlers) {
            if (!handler.disconnected)
                handler.callback.call(this, ...args);
        }
    }

    disconnectAll() {
        this.disconnectAllCalls++;
        for (const connection of this._connections.values())
            connection.disconnected = true;
        this._connections.clear();
    }

    handlerCount(name) {
        return [...this._connections.values()].filter(c => c.name === name && !c.disconnected).length;
    }
}

export const GObject = {
    Object: class GObjectObject {},
    registerClass(_meta, klass) {
        klass.GTypeName = klass.name;
        return klass;
    },
};

export const Signals = {EventEmitter};

export const Clutter = {
    EventType: {KEY_PRESS: 'key-press', BUTTON_PRESS: 'button-press', BUTTON_RELEASE: 'button-release', MOTION: 'motion'},
    KEY_Escape: 'Escape',
    CursorType: {DEFAULT: 'default', CROSSHAIR: 'crosshair'},
};

class Actor extends EventEmitter {
    constructor(props = {}) {
        super();
        this.name = props.name;
        this.destroyed = false;
        this.parent = null;
        this.width = 100;
        this.height = 20;
        this.opacity = 255;
        this.cursorType = null;
        this.position = {x: 0, y: 0};
        this.size = {w: 0, h: 0};
    }

    get_parent() {
        return this.parent;
    }

    set_position(x, y) {
        this.position = {x, y};
    }

    set_size(w, h) {
        this.size = {w, h};
    }

    set_text(text) {
        this.text = text;
    }

    set_cursor_type(type) {
        this.cursorType = type;
    }

    hide() {
        this.visible = false;
    }

    destroy() {
        if (this.destroyed)
            throw new Error(`double destroy of ${this.name}`);
        this.destroyed = true;
        if (this.parent)
            this.parent.remove_child(this);
    }
}

export const St = {Widget: class Widget extends Actor {}, Label: class Label extends Actor {}};

export const uiGroup = {
    children: [],
    add_child(child) {
        this.children.push(child);
        child.parent = this;
    },
    remove_child(child) {
        const index = this.children.indexOf(child);
        if (index < 0) {
            log.push(`WARN remove_child of non-child ${child.name}`);
            return;
        }
        this.children.splice(index, 1);
        child.parent = null;
    },
};

export const Main = {
    uiGroup,
    grab: {id: 'grab'},
    popped: [],
    layoutManager: {
        focusMonitor: {width: 1920, height: 1080},
        currentMonitor: {x: 10, y: 20, width: 800, height: 600},
    },
    overview: new EventEmitter(),
    pushModal() {
        return this.grab;
    },
    popModal(grab) {
        this.popped.push(grab);
        return true;
    },
};

class FakeNotifyManager {
    constructor() {
        this.alerts = [];
        this.resetCalls = 0;
    }

    createAlert(message) {
        this.alerts.push({message});
    }

    resetAlert() {
        this.resetCalls++;
        this.alerts = [];
    }
}

export const UtilNotify = {NotifyManager: FakeNotifyManager};

export const Lib = {TalkativeLog() {}};

export const savedRects = [];
export const Ext = {
    Indicator: {
        saveSelectedRect(x, y, h, w) {
            savedRects.push({x, y, h, w});
        },
        _doDelayAction() {
            savedRects[savedRects.length - 1].delayActionCalled = true;
        },
        getSelectedRect() {
            return [100, 100, 400, 300];
        },
    },
};

export const DisplayApi = {
    number_displays() {
        return 1;
    },
    display_geometry_for_index() {
        return {x: 0, y: 0, width: 1920, height: 1080};
    },
};

export const gettext = message => message;

/**
 *
 */
export function makeGlobal() {
    return {
        pointer: {x: 0, y: 0},
        windowActors: [],
        get_pointer() {
            return [this.pointer.x, this.pointer.y];
        },
        get_window_actors() {
            return this.windowActors;
        },
        screen_width: 1920,
        screen_height: 1080,
    };
}

export const event = (type, {key = null, button = 1} = {}) => ({
    type: () => type,
    get_key_symbol: () => key,
    get_button: () => button,
});
