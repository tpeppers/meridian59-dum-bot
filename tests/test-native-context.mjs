import assert from 'node:assert/strict';
import {strategyRevision,updateStrategies} from '../src/link/strategy-control.mjs';
import {STRATEGY_IDS} from '../src/strategies/catalog.mjs';
const test=globalThis.__dumTest;
test('native context: stale/restarted policy writes are refused without mutation',async()=>{
  let changes=0;const states={example:{state:'all'}};
  const store={fleet:'fixture-fleet',states:()=>({states}),update:()=>{changes++;return {states};}};
  const body={agents:['fixture-unit'],expected_fleet:store.fleet,expected_pid:process.pid,
    expected_revision:strategyRevision(store.fleet,['fixture-unit'],states),changes:{example:false}};
  await updateStrategies(store,body);assert.equal(changes,1);
  for(const b of [{...body,expected_pid:process.pid+1},{...body,expected_fleet:'other-fixture'},
    {...body,expected_revision:'stale'}])await assert.rejects(()=>updateStrategies(store,b),e=>e.status===409);
  assert.equal(changes,1);
  await updateStrategies(store,{agents:['fixture-unit'],changes:{example:true}});assert.equal(changes,2,'legacy API remains compatible');
});
test('native context: compare-and-set occurs after asynchronous item canonicalization',async()=>{
  let current={example:{state:'all'}},changes=0;
  const store={fleet:'fixture-fleet',states:()=>({states:current}),update:()=>{changes++;}};
  const body={agents:['fixture-unit'],expected_fleet:store.fleet,expected_pid:process.pid,
    expected_revision:strategyRevision(store.fleet,['fixture-unit'],current),
    settings:{[STRATEGY_IDS.ACCUMULATE_IN_VAULT]:{items:['fixture item']}}};
  await assert.rejects(()=>updateStrategies(store,body,async items=>{await Promise.resolve();current={example:{state:'none'}};return items;}),e=>e.status===409);
  assert.equal(changes,0);
});
