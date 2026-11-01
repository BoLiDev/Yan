import { afterAll } from 'vitest';
import { restoreVault } from './fixtures.js';

// Run before every test file. A suite started from inside a yan session, or by
// a shift, inherits the variables that name that task and shift; a test that
// sets no $YAN_TASK would then resolve the real one instead of reporting the
// usage error it is about, and every child `runYan` spawns inherits the same.
// The machine-level variables (YAN_HOME, YAN_VAULT, YAN_MACHINE_DIR) stay,
// because every fixture sets the ones it needs on its own, and the vault it
// set is put back when the file is done.
for (const key of ['YAN_TASK', 'YAN_TASK_DIR', 'YAN_SID', 'YAN_SHIFT_DIR']) {
  delete process.env[key];
}

// A suite started in a herdr pane inherits the variables that name that pane
// and its herdr. `yan serve` takes $HERDR_BIN_PATH for the herdr it opens a
// launch's tab in, ahead of the one a test's vault names, so its tests would
// open tabs in the real herdr, and bare `yan` would take the test for an agent
// in that pane. A test that means herdr to be there sets these itself.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('HERDR_')) delete process.env[key];
}

// `yan serve` opens its page in the platform's opener: a browser tab. No test may do that, so the opener is
// nothing unless a test names one.
process.env.YAN_OPENER = '';

afterAll(restoreVault);
