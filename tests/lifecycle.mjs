// Regression coverage for the selection lifecycle in selection.js.
//
// GNOME Shell cannot be started in CI, so the module is loaded with its shell
// imports redirected to the stubs in ./stubs.mjs, and the event/cleanup paths
// (ESC, click, disable, double destroy, throwing settings write) are driven
// directly. Run with: npm test
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

import * as S from './stubs.mjs';

const SOURCE = new URL('../selection.js', import.meta.url);
const STUBS = new URL('./stubs.mjs', import.meta.url).href;

let failures = 0;
function check(name, condition, extra = '') {
    if (condition) {
        console.log(`  ok   ${name}`);
        return;
    }
    failures++;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
}

/**
 * Loads selection.js with the GNOME Shell imports replaced by ./stubs.mjs.
 *
 * @returns {Promise<object>} the selection module
 */
async function loadSelection() {
    const source = readFileSync(SOURCE, 'utf8');
    const firstImport = source.indexOf('import GObject');
    const body = source.indexOf('/**', source.indexOf('import {DisplayApi}'));
    if (firstImport < 0 || body < 0)
        throw new Error('selection.js import block changed, update tests/lifecycle.mjs');

    const patched = [
        `import {GObject, Clutter, St, Main, Signals, gettext as _, Lib, Ext, UtilNotify, DisplayApi, makeGlobal} from '${STUBS}';`,
        'globalThis.global = makeGlobal();',
        '',
        source.slice(body),
    ].join('\n');

    const dir = mkdtempSync(join(tmpdir(), 'easyscreencast-lifecycle-'));
    const file = join(dir, 'selection-under-test.mjs');
    writeFileSync(file, patched);
    try {
        return await import(pathToFileURL(file).href);
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
}

function reset() {
    S.Main.uiGroup.children.length = 0;
    S.Main.popped.length = 0;
    S.savedRects.length = 0;
    S.log.length = 0;
    S.Main.overview.disconnectAll();
    globalThis.global = S.makeGlobal();
}
function reportWarnings() {
    return S.log.filter(line => line.startsWith('WARN')).join('; ');
}

const Sel = await loadSelection();

console.log('Capture / SelectionArea: ESC tears everything down exactly once');
{
    reset();
    const area = new Sel.SelectionArea();
    const capture = area._capture;
    const captureStops = [];
    const areaStops = [];
    capture.connect('stop', () => captureStops.push('capture-stop'));
    area.connect('stop', () => areaStops.push('area-stop'));
    const emitted = [];
    capture.connect('captured-event', ev => emitted.push(ev));

    check('selection actors are on screen', S.Main.uiGroup.children.length >= 2);
    check('modal grab pushed', capture._grab === S.Main.grab);

    capture._onCaptureEvent(null, S.event('key-press', {key: 'Escape'}));

    check('capture released', capture._destroyed === true && capture._areaSelection === null &&
        capture._areaResolution === null);
    check('modal grab popped once and released', S.Main.popped.length === 1 && capture._grab === null);
    check('uiGroup emptied', S.Main.uiGroup.children.length === 0,
        `left: ${S.Main.uiGroup.children.map(c => c.name)}`);
    check('alert removed', area._ctrlNotify === null);
    check("capture emitted 'stop' once", captureStops.length === 1, `${captureStops.length}`);
    check("selection emitted 'stop' once (re-entrant destroy() was a no-op)", areaStops.length === 1,
        `${areaStops.length}`);
    check('capture handlers disconnected', capture.handlerCount('stop') === 0);
    check('ESC did not fall through to emit(captured-event)', emitted.length === 0);

    area.destroy();
    capture.destroy();
    check('double destroy pops no modal twice', S.Main.popped.length === 1);
    check('double destroy emits no extra stop', areaStops.length === 1 && captureStops.length === 1);
    check('drawSelection() after destroy is a no-op', (() => {
        capture.drawSelection({x: 0, y: 0, w: 10, h: 10}, true);
        return true;
    })());
}

console.log('SelectionArea: click path saves the rect before the teardown');
{
    reset();
    const area = new Sel.SelectionArea();
    const capture = area._capture;

    area._onEvent(null, S.event('button-press'));
    check('mouseDown tracked', area._mouseDown === true && area._startX === 0);

    globalThis.global.pointer.x = 100;
    globalThis.global.pointer.y = 50;
    area._onEvent(null, S.event('motion'));
    check('highlight follows the pointer', capture._areaSelection.size.w === 100 &&
        capture._areaSelection.size.h === 50);

    area._onEvent(null, S.event('button-release'));
    check('rect saved once', S.savedRects.length === 1, `${S.savedRects.length}`);
    check('rect math unchanged', JSON.stringify(S.savedRects[0]) ===
        JSON.stringify({x: 0, y: 0, h: 50, w: 100, delayActionCalled: true}), JSON.stringify(S.savedRects[0]));
    check('teardown ran after the settings write', area._destroyed === true && capture._destroyed === true);
    check('capture released', area._capture === null);
    check('modal popped once', S.Main.popped.length === 1);
    check('uiGroup emptied', S.Main.uiGroup.children.length === 0);
    check('alert removed', area._ctrlNotify === null);
    check('no double destroy of actors', !reportWarnings(), reportWarnings());

    area._onEvent(null, S.event('button-release'));
    check('late events ignored after destroy', S.savedRects.length === 1);
}

console.log('SelectionArea: a throwing settings write still tears the selection down');
{
    reset();
    const area = new Sel.SelectionArea();
    const originalSave = S.Ext.Indicator.saveSelectedRect;
    S.Ext.Indicator.saveSelectedRect = () => {
        throw new Error('settings write failed');
    };

    let thrown = null;
    area._onEvent(null, S.event('button-press'));
    globalThis.global.pointer.x = 20;
    globalThis.global.pointer.y = 20;
    try {
        area._onEvent(null, S.event('button-release'));
    } catch (e) {
        thrown = e;
    } finally {
        S.Ext.Indicator.saveSelectedRect = originalSave;
    }

    check('the exception still propagates', thrown !== null && thrown.message === 'settings write failed');
    check('selection torn down anyway', area._destroyed === true && area._capture === null);
    check('modal grab released', S.Main.popped.length === 1);
    check('uiGroup emptied', S.Main.uiGroup.children.length === 0);
    check('alert removed', area._ctrlNotify === null);
}

console.log('SelectionWindow: window click saves then tears down');
{
    reset();
    const win = new Sel.SelectionWindow();
    const capture = win._capture;
    const fakeWindow = {
        visible: true,
        get_size: () => [400, 300],
        get_position: () => [-5, -7],
        get_meta_window: () => ({get_layer: () => 0}),
    };
    globalThis.global.windowActors = [fakeWindow];
    win._windows = globalThis.global.windowActors;

    let captureAtSave = null;
    const originalSave = S.Ext.Indicator.saveSelectedRect;
    S.Ext.Indicator.saveSelectedRect = (...args) => {
        captureAtSave = {captureNull: win._capture === null, destroyed: capture._destroyed};
        originalSave(...args);
    };
    globalThis.global.pointer.x = 10;
    globalThis.global.pointer.y = 10;
    win._onEvent(null, S.event('button-press'));
    S.Ext.Indicator.saveSelectedRect = originalSave;

    check('rect saved', S.savedRects.length === 1, `${S.savedRects.length}`);
    check('negative window position clamped to 0', S.savedRects[0].x === 0 && S.savedRects[0].y === 0,
        JSON.stringify(S.savedRects[0]));
    check('save happened before _capture was nulled', captureAtSave && captureAtSave.captureNull === false);
    check('teardown ran after the save', win._destroyed === true && win._capture === null);
    check('window list released', win._windows === null && win._selectedWindow === null);
    check('alert removed', win._ctrlNotify === null);
    check('modal popped once', S.Main.popped.length === 1);
    check('uiGroup emptied', S.Main.uiGroup.children.length === 0);
}

console.log('SelectionWindow: ESC path');
{
    reset();
    const win = new Sel.SelectionWindow();
    const stops = [];
    win.connect('stop', () => stops.push('window-stop'));
    win._capture._onCaptureEvent(null, S.event('key-press', {key: 'Escape'}));
    check('re-entrant destroy() from capture.stop is a no-op', win._destroyed === true && stops.length === 1,
        `${stops.length}`);
    check('modal popped once', S.Main.popped.length === 1);
    check('uiGroup emptied', S.Main.uiGroup.children.length === 0);
}

console.log('SelectionDesktop: desktop click saves then tears down');
{
    reset();
    const desktop = new Sel.SelectionDesktop();
    globalThis.global.pointer.x = 1;
    globalThis.global.pointer.y = 1;
    desktop._onEvent(null, S.event('button-press'));
    check('current monitor saved', JSON.stringify({
        x: S.savedRects[0].x, y: S.savedRects[0].y, h: S.savedRects[0].h, w: S.savedRects[0].w,
    }) === JSON.stringify({x: 10, y: 20, h: 600, w: 800}), JSON.stringify(S.savedRects[0]));
    check('teardown ran', desktop._destroyed === true && desktop._capture === null);
    check('modal popped once', S.Main.popped.length === 1);
    check('uiGroup emptied', S.Main.uiGroup.children.length === 0);
}

console.log('AreaRecording: destroy() releases actors and overview handlers');
{
    reset();
    const rec = new Sel.AreaRecording();
    check('four edge strips added', S.Main.uiGroup.children.length === 4);
    check('overview handlers connected', S.Main.overview.handlerCount('showing') === 1 &&
        S.Main.overview.handlerCount('hidden') === 1);
    check('isVisible() reports the drawn frame', rec.isVisible() === true);

    rec.destroy();
    check('edges destroyed', S.Main.uiGroup.children.length === 0);
    check('edge list released', rec._edges === null);
    check('overview handlers disconnected', S.Main.overview.handlerCount('showing') === 0 &&
        S.Main.overview.handlerCount('hidden') === 0);
    check('isVisible() false after destroy', rec.isVisible() === false);
    check('clearArea()/drawArea() after destroy are no-ops', (() => {
        rec.clearArea();
        rec.drawArea(0, 0, 10, 10);
        return rec._edges === null;
    })());
    rec.destroy();
    check('double destroy is a no-op', S.Main.overview.handlerCount('showing') === 0);
}

console.log('AreaRecording: isVisible() is a boolean before the first draw');
{
    reset();
    // a rect that does not fit the monitor means the constructor draws nothing
    const originalRect = S.Ext.Indicator.getSelectedRect;
    S.Ext.Indicator.getSelectedRect = () => [0, 0, 5000, 5000];
    const rec = new Sel.AreaRecording();
    S.Ext.Indicator.getSelectedRect = originalRect;

    check('frame not drawn for an oversized rect', rec.isVisible() === false,
        `isVisible() returned ${String(rec.isVisible())}`);
    rec.destroy();
}

console.log('AreaRecording: destroy() while the overview has the strips detached');
{
    reset();
    const rec = new Sel.AreaRecording();
    S.Main.overview.emit('showing');
    check('strips detached on overview open', S.Main.uiGroup.children.length === 0);
    rec.destroy();
    check('no warnings for already-detached strips', !reportWarnings(), reportWarnings());
    check('strips destroyed anyway', rec._edges === null);
    check('overview handlers disconnected', S.Main.overview.handlerCount('showing') === 0 &&
        S.Main.overview.handlerCount('hidden') === 0);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
