'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ai = require('../server/enhance');
const { PRESETS } = require('../server/presets');
const probe = { video: { width: 540, height: 960, fps: 30 }, format: { durationSec: 10 } };
test('AI plan respects portrait, social cap, SDR and preview duration', () => {
  const p = ai.plan(probe, PRESETS.reels_hq, { scale: 4, fps: 60, denoise: 'gentle' }, true);
  assert.equal(p.width,1080); assert.equal(p.height,1920); assert.equal(p.fps,60); assert.equal(p.duration,5); assert.equal(p.color,'BT.709 SDR');
  assert.ok(p.scratchBytes > 540 * 960 * 300 * 16);
  const master = ai.plan(probe,PRESETS.master_4k120,{scale:4,fps:120});
  assert.equal(master.height,3840); assert.equal(master.fps,120);
});
test('invalid AI settings, remux and incompatible motion are rejected', () => {
  assert.throws(()=>ai.options({scale:99}));
  assert.throws(()=>ai.options({scale:0}));
  assert.throws(()=>ai.options({fps:NaN}));
  assert.throws(()=>ai.options({fps:NaN,denoise:'invented'}));
  assert.throws(()=>ai.plan(probe,PRESETS.remux,{scale:2}));
  assert.throws(()=>ai.plan(probe,PRESETS.reels_hq,{fps:120}));
  assert.throws(()=>ai.plan({...probe,video:{...probe.video,fps:120}},PRESETS.master_4k120,{fps:60}));
});
test('noise-only plan needs no intermediate PNG storage',()=>{
  assert.equal(ai.plan(probe,PRESETS.reels_hq,{denoise:'gentle'}).scratchBytes,0);
});
test('AI cleanup refuses unrelated files and only removes its own workspace', () => {
  const root=path.resolve('.test-data','ai-cleanup'); fs.mkdirSync(root,{recursive:true});
  const keep=path.join(root,'keep'); fs.mkdirSync(keep,{recursive:true});
  assert.throws(()=>ai.cleanup(keep,root)); assert.ok(fs.existsSync(keep));
  const own=path.join(root,'forge-ai-abc123');fs.mkdirSync(own,{recursive:true});
  ai.cleanup(own,root);assert.equal(fs.existsSync(own),false);
});
