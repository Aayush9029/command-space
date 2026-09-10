import test from "node:test";
import assert from "node:assert/strict";
import { WindowManagement } from "../windows.mjs";

const target = process.env.SUPER_SPACE_WINDOW_TEST_ID;
test("Linux window API reads and resizes an explicitly selected disposable test window", {skip:!target}, async () => {
  process.env.SUPER_SPACE_FRONTMOST = JSON.stringify({id:target});
  const initial = await WindowManagement.getActiveWindow();
  assert.equal(initial.id,target);
  assert.ok(initial.positionable && initial.resizable);
  const desktops = await WindowManagement.getDesktops();
  assert.ok(desktops.some(desktop => desktop.id === initial.desktopId));
  const bounds = {position:{x:80,y:80},size:{width:480,height:280}};
  try {
    await WindowManagement.setWindowBounds({id:target,bounds});
    await new Promise(resolve => setTimeout(resolve,150));
    assert.deepEqual((await WindowManagement.getActiveWindow()).bounds,bounds);
    assert.ok((await WindowManagement.getWindowsOnActiveDesktop()).some(window => window.id === target));
    await assert.rejects(WindowManagement.setWindowBounds({id:target,bounds:{size:{width:-1}}}),/positive dimensions/);
  } finally { await WindowManagement.setWindowBounds({id:target,bounds:initial.bounds}); }
});
