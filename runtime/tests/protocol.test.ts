import test from "node:test";
import assert from "node:assert/strict";
import { inputMessage, outputMessage, protocolLines, renderTree } from "../protocol.ts";
import { extensionManifest } from "../manifest.ts";

async function lines(chunks: (string | Uint8Array)[], limit?: number): Promise<string[]> {
  async function* input(): AsyncGenerator<string | Uint8Array> { yield* chunks; }
  return Array.fromAsync(protocolLines(input(), limit));
}

test("protocol framing preserves split UTF-8, CRLF, empty records and final records", async () => {
  const bytes = Buffer.from('🙂\r\n\n{"value":"é"}\nlast');
  const chunks = Array.from(bytes, byte => Uint8Array.of(byte));
  assert.deepEqual(await lines(chunks), ['🙂', '', '{"value":"é"}', 'last']);
  assert.deepEqual(await lines(['first\nsecond', '\nthird']), ['first', 'second', 'third']);
});

test("protocol limits bytes per complete or incomplete record", async () => {
  assert.deepEqual(await lines(['12\n34\n', '56'], 2), ['12', '34', '56']);
  assert.deepEqual(await lines([Buffer.from('🙂')], 4), ['🙂']);
  await assert.rejects(lines(['123\n'], 2), /exceeds 2 bytes/);
  await assert.rejects(lines(['1', '2', '3'], 2), /exceeds 2 bytes/);
  await assert.rejects(lines([Buffer.from('éé')], 3), /exceeds 3 bytes/);
});

test("input messages validate discriminators and argument shapes before dispatch", () => {
  for (const value of [null, [], {}, {type:'unknown'}, {type:'launch',extension:'',command:'x'}, {type:'launch',extension:'x',command:'y',arguments:[]}, {type:'launch',extension:'x',command:'y',launchType:'invalid'}, {type:'event',callback:5}, {type:'event',callback:'x',args:{}}, {type:'event',callback:'x',inputRevision:-1}, {type:'response',id:'1',error:false}]) {
    assert.throws(() => inputMessage(value));
  }
  assert.deepEqual(inputMessage({type:'launch',extension:'/fixture',command:'command',arguments:null,launchType:'background',scheduled:true}), {type:'launch',extension:'/fixture',command:'command',arguments:null,launchType:'background',scheduled:true});
  assert.deepEqual(inputMessage({type:'event',callback:'generation:1',args:['value'],field:'field',inputRevision:1}), {type:'event',callback:'generation:1',args:['value'],field:'field',inputRevision:1});
  assert.deepEqual(inputMessage({type:'stop',ignored:true}), {type:'stop'});
  assert.throws(() => outputMessage({type:7}), /typed object/);
});

test("render trees reject malformed nodes and bounded recursion", () => {
  assert.deepEqual(renderTree([{id:'1',type:'List',props:{title:'list'}}]), [{id:'1',type:'List',props:{title:'list'},children:[]}]);
  for (const value of [null, [{id:1,type:'List',props:{}}], [{id:'1',type:'List',props:[]}], [{id:'1',type:'List',props:{},children:{}}]]) assert.throws(() => renderTree(value), /Invalid extension render/);
  let tree: unknown = [];
  for (let i = 0; i < 300; i++) tree = [{id:String(i),type:'List',props:{},children:tree}];
  assert.throws(() => renderTree(tree), /Invalid extension render tree/);
});

test("manifest decoding validates consumed fields while preserving field defaults", () => {
  const manifest = extensionManifest({ name:'fixture', author:'owner', ignored:'metadata', preferences:[{name:'enabled',type:'checkbox',default:false}], commands:[{name:'command',arguments:[{name:'choice',type:'dropdown',required:true,data:[{value:'a',title:'A'}]}]}] });
  assert.equal(manifest.title,'fixture');
  assert.equal(manifest.commands[0].title,'command');
  assert.equal(manifest.commands[0].mode,'view');
  assert.equal(manifest.preferences[0].default,false);
  assert.deepEqual(manifest.commands[0].arguments[0].data,[{value:'a',title:'A'}]);
  for (const value of [null, {name:'fixture',commands:{}}, {name:'fixture',commands:[{name:'command',path:7}]}, {name:'fixture',commands:[{name:'command',arguments:[{name:'choice',required:'yes'}]}]}, {name:'fixture',commands:[{name:'command',arguments:[{name:'choice',data:[{value:1,title:'A'}]}]}]}]) assert.throws(() => extensionManifest(value), /Extension|Invalid extension/);
});
