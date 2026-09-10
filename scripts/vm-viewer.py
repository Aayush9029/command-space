#!/usr/bin/env python3
import argparse
import http.server
import json
import secrets
import socket
import subprocess
import threading
import time
import urllib.parse


parser = argparse.ArgumentParser()
parser.add_argument("--qmp")
parser.add_argument("--self-test", action="store_true")
parser.add_argument("--port", type=int, default=8766)
parser.add_argument("--vm", default="omarchy")
args = parser.parse_args()
if not args.self_test and not args.qmp:
    parser.error("--qmp is required unless --self-test is used")
token = secrets.token_urlsafe(24)
lock = threading.Lock()


def qmp(commands):
    with lock, socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(5)
        connection.connect(args.qmp)
        with connection.makefile("rwb", buffering=0) as stream:
            stream.readline()
            result = None
            for command in [{"execute": "qmp_capabilities"}] + commands:
                stream.write((json.dumps(command) + "\n").encode())
                while True:
                    response = json.loads(stream.readline())
                    if "error" in response:
                        raise RuntimeError(response["error"])
                    if "return" in response:
                        result = response["return"]
                        break
                if command["execute"] == "input-send-event":
                    time.sleep(0.025)
            return result


def input_events(events):
    return {"execute": "input-send-event", "arguments": {"events": events}}


FRAME_QUEUE = '''function createFrameQueue({send,capture,display,discard=()=>{},onError=()=>{},settleMs=600}){
  let queue=Promise.resolve();
  let inputSequence=0;
  let completedInputSequence=0;
  let lastInputAt=0;
  let requestSequence=0;
  let frameSequence=0;
  let refreshTimer;
  let refreshTask;
  let waiters=[];
  function clearRefreshTimer(){clearTimeout(refreshTimer);refreshTimer=undefined}
  function post(value){
    const sequence=++inputSequence;
    clearRefreshTimer();
    queue=queue.then(()=>send(value)).catch(onError).then(()=>{
      completedInputSequence=sequence;
      lastInputAt=Date.now();
      if(sequence===inputSequence&&!refreshTask){
        refreshTimer=setTimeout(()=>{refreshTimer=undefined;refresh().catch(onError)},settleMs);
      }
    });
    return queue;
  }
  async function capturePending(){
    while(waiters.length){
      const pendingInputs=queue;
      await pendingInputs;
      if(pendingInputs!==queue)continue;
      const delay=settleMs-(Date.now()-lastInputAt);
      if(delay>0)await new Promise(resolve=>setTimeout(resolve,delay));
      if(pendingInputs!==queue)continue;
      const captureInput=completedInputSequence;
      const captureSequence=requestSequence;
      const frame=await capture(captureSequence,captureInput);
      try{
        if(captureInput!==inputSequence)continue;
        await display(frame);
        frameSequence=captureSequence;
        const completed=waiters.filter(waiter=>waiter.sequence<=frameSequence);
        waiters=waiters.filter(waiter=>waiter.sequence>frameSequence);
        for(const waiter of completed)waiter.resolve({frameSequence,inputSequence:captureInput});
      }finally{discard(frame)}
    }
  }
  function startCapture(){
    if(refreshTask)return;
    refreshTask=Promise.resolve().then(capturePending).catch(error=>{
      const failed=waiters;
      waiters=[];
      for(const waiter of failed)waiter.reject(error);
    }).finally(()=>{
      refreshTask=undefined;
      if(waiters.length)startCapture();
    });
  }
  function refresh(){
    clearRefreshTimer();
    const sequence=++requestSequence;
    const result=new Promise((resolve,reject)=>waiters.push({sequence,resolve,reject}));
    startCapture();
    return result;
  }
  return {post,refresh,get queue(){return queue},get frameSequence(){return frameSequence}};
}
'''


PAGE = '''<!doctype html><html><meta charset="utf-8"><title>Command Space — live Omarchy VM</title>
<style>body{margin:0;background:#101116;color:#b4bee6;font:13px monospace}header{display:flex;gap:14px;align-items:center;padding:10px 14px}button,input{background:#24283b;color:#c0caf5;border:1px solid #414868;padding:7px;font:inherit}input{flex:1}canvas{display:block;width:100%;outline:0;user-select:none}small{color:#7aa2f7}</style>
<header><strong>Live Omarchy VM</strong><input id="typing" aria-label="Type into VM" placeholder="Type into the focused guest field"><button id="send">Type</button><button data-key="ret">Enter</button><button data-key="esc">Escape</button><button data-key="up">↑</button><button data-key="down">↓</button><small id="status">Connecting</small></header>
<header><button data-chord="meta_l,spc">Super+Space</button><button data-chord="meta_l,ctrl,v">Clipboard</button><button data-chord="meta_l,ctrl,e">Emoji</button><button data-chord="ctrl,k">Actions</button><button data-chord="ctrl,a">Select All</button><button data-key="tab">Tab</button><button data-chord="shift,tab">Shift+Tab</button><button data-key="spc">Space</button><button data-chord="ctrl,e">Ctrl+E</button><button data-key="pgdn">Page Down</button><button data-key="pgup">Page Up</button><button id="refresh">Refresh view</button></header>
<canvas id="screen" tabindex="0" aria-label="Live Omarchy desktop"></canvas>
<script>''' + FRAME_QUEUE + '''
const token = new URLSearchParams(location.search).get('token');
const screen = document.querySelector('#screen');
const status=document.querySelector('#status');
const frames=createFrameQueue({
  send:async value=>{
    const response=await fetch('/input?token='+token,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
    if(!response.ok)throw Error('Input failed: '+response.status);
  },
  capture:async sequence=>{
    const response=await fetch('/frame?token='+token+'&sequence='+sequence+'&t='+Date.now());
    if(!response.ok)throw Error('Frame delayed');
    const url=URL.createObjectURL(await response.blob());
    try{
      const image=new Image();image.src=url;await image.decode();
      return {image,url};
    }catch(error){URL.revokeObjectURL(url);throw error}
  },
  display:({image})=>{
    screen.width=image.naturalWidth;screen.height=image.naturalHeight;
    screen.getContext('2d').drawImage(image,0,0);
    status.textContent='Live';
  },
  discard:({url})=>URL.revokeObjectURL(url),
  onError:error=>status.textContent=error.message
});
let queue=frames.queue;
function post(value){queue=frames.post(value);return queue}
function refresh(){return frames.refresh()}
document.querySelector('#refresh').onclick=()=>refresh().catch(error=>status.textContent=error.message);
screen.onclick=e=>{const r=screen.getBoundingClientRect();post({type:'click',x:(e.clientX-r.left)/r.width,y:(e.clientY-r.top)/r.height});screen.focus()};
document.querySelector('#send').onclick=()=>{const field=document.querySelector('#typing');post({type:'text',text:field.value});field.value=''};
document.querySelector('#typing').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();document.querySelector('#send').click()}};
document.querySelectorAll('[data-key]').forEach(button=>button.onclick=()=>post({type:'key',key:button.dataset.key}));
document.querySelectorAll('[data-chord]').forEach(button=>button.onclick=()=>post({type:'chord',keys:button.dataset.chord.split(',')}));
screen.onwheel=e=>{e.preventDefault();post({type:'wheel',direction:e.deltaY>0?'wheel-down':'wheel-up'})};
const keys={Enter:'ret',Escape:'esc',ArrowUp:'up',ArrowDown:'down',ArrowLeft:'left',ArrowRight:'right',Backspace:'backspace',Tab:'tab',Space:'spc',ControlLeft:'ctrl',ControlRight:'ctrl_r',MetaLeft:'meta_l',MetaRight:'meta_r',AltLeft:'alt',AltRight:'alt_r',ShiftLeft:'shift',ShiftRight:'shift_r'};
screen.onkeydown=e=>{e.preventDefault();const key=keys[e.code]||(e.code.startsWith('Key')?e.code.slice(3).toLowerCase():e.code.startsWith('Digit')?e.code.slice(5):null);if(key)post({type:'key-state',key,down:true})};
screen.onkeyup=e=>{e.preventDefault();const key=keys[e.code]||(e.code.startsWith('Key')?e.code.slice(3).toLowerCase():e.code.startsWith('Digit')?e.code.slice(5):null);if(key)post({type:'key-state',key,down:false})};
refresh().catch(error=>status.textContent=error.message);
</script></html>'''


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def authorized(self):
        return secrets.compare_digest(urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("token", [""])[0], token)

    def respond(self, status, mime, body):
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self.authorized():
            return self.respond(403, "text/plain", b"Forbidden")
        if urllib.parse.urlparse(self.path).path == "/frame":
            try:
                frame = subprocess.run(["ssh", "-o", "BatchMode=yes", args.vm, "systemd-run --user --quiet --wait --pipe --collect /usr/bin/timeout 4 /usr/bin/grim -l 1 -"], capture_output=True, check=True, timeout=8)
                self.respond(200, "image/png", frame.stdout)
            except Exception as error:
                self.respond(500, "text/plain", str(error).encode())
        else:
            self.respond(200, "text/html; charset=utf-8", PAGE.encode())

    def do_POST(self):
        if not self.authorized() or int(self.headers.get("Content-Length", "0")) > 16384:
            return self.respond(403, "text/plain", b"Forbidden")
        try:
            message = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            commands = []

            def key(name, down):
                commands.append(input_events([{"type": "key", "data": {"down": down, "key": {"type": "qcode", "data": name}}}]))

            if message["type"] == "click":
                axes = [{"type": "abs", "data": {"axis": axis, "value": int(max(0, min(1, message[axis])) * 32767)}} for axis in ("x", "y")]
                commands.append(input_events(axes))
                for down in (True, False):
                    commands.append(input_events([{"type": "btn", "data": {"button": "left", "down": down}}]))
            elif message["type"] in ("key", "key-state"):
                if message["type"] == "key-state":
                    key(message["key"], bool(message["down"]))
                else:
                    key(message["key"], True)
                    key(message["key"], False)
            elif message["type"] == "chord":
                for name in message["keys"]:
                    key(name, True)
                for name in reversed(message["keys"]):
                    key(name, False)
            elif message["type"] == "wheel":
                for _ in range(3):
                    for down in (True, False):
                        commands.append(input_events([{"type": "btn", "data": {"button": message["direction"], "down": down}}]))
            elif message["type"] == "text":
                plain = {" ": "spc", "\n": "ret", "\t": "tab", "-": "minus", "=": "equal", ",": "comma", ".": "dot", "/": "slash", ";": "semicolon", "'": "apostrophe", "[": "bracket_left", "]": "bracket_right", "\\": "backslash", "`": "grave_accent"}
                shifted = dict(zip('!@#$%^&*()_+<>?:"{}|~', ['1','2','3','4','5','6','7','8','9','0','minus','equal','comma','dot','slash','semicolon','apostrophe','bracket_left','bracket_right','backslash','grave_accent']))
                for character in message["text"]:
                    shift = character.isupper() or character in shifted
                    name = shifted.get(character, plain.get(character, character.lower()))
                    if not character.isascii():
                        raise ValueError("Use the VM clipboard for non-ASCII text")
                    if shift:
                        key("shift", True)
                    key(name, True)
                    key(name, False)
                    if shift:
                        key("shift", False)
            qmp(commands)
            self.respond(200, "application/json", b'{"ok":true}')
        except Exception as error:
            self.respond(400, "text/plain", str(error).encode())


FRAME_QUEUE_TEST = r"""
const assert=await import('node:assert/strict');
const {test}=await import('node:test');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve}};
async function until(predicate){
  for(let attempt=0;attempt<100;attempt++){if(predicate())return;await pause(2)}
  throw Error('Frame queue did not reach the expected state');
}

test('refresh waits for a frame captured after completed input',async()=>{
  const captures=[],shown=[],discarded=[];
  const frames=createFrameQueue({
    settleMs:0,send:async()=>{},
    capture:(sequence,input)=>{const frame=deferred();captures.push({sequence,input,...frame});return frame.promise},
    display:frame=>shown.push(frame),discard:frame=>discarded.push(frame)
  });
  const first=frames.refresh();
  await until(()=>captures.length===1);
  await frames.post({type:'key',key:'ret'});
  await frames.queue;
  let complete=false;
  const second=frames.refresh().then(result=>{complete=true;return result});
  captures[0].resolve('old frame');
  await until(()=>captures.length===2);
  assert.equal(complete,false);
  assert.deepEqual(shown,[]);
  assert.equal(captures[1].input,1);
  captures[1].resolve('fresh frame');
  const result=await second;
  await first;
  assert.deepEqual(result,{frameSequence:2,inputSequence:1});
  assert.deepEqual(shown,['fresh frame']);
  assert.deepEqual(discarded,['old frame','fresh frame']);
});

test('a queued input batch produces one settled automatic frame',async()=>{
  const sent=[],captures=[];
  const frames=createFrameQueue({
    settleMs:10,send:async value=>{await pause(3);sent.push(value)},
    capture:(sequence,input)=>{captures.push({sequence,input,sent:[...sent]});return input},display:()=>{}
  });
  frames.post('first');frames.post('second');frames.post('third');
  await frames.queue;
  await until(()=>captures.length===1);
  await pause(25);
  assert.equal(captures.length,1);
  assert.deepEqual(captures[0].sent,['first','second','third']);
  assert.equal(captures[0].input,3);
});

test('manual refresh consumes pending automatic work and concurrent requests',async()=>{
  const captures=[];
  const frames=createFrameQueue({
    settleMs:10,send:async()=>{},capture:sequence=>{captures.push(sequence);return sequence},display:()=>{}
  });
  await frames.post('input');
  const results=await Promise.all([frames.refresh(),frames.refresh()]);
  await pause(25);
  assert.deepEqual(captures,[2]);
  assert.deepEqual(results,[{frameSequence:2,inputSequence:1},{frameSequence:2,inputSequence:1}]);
});

test('capture failures reject refresh and allow a later retry',async()=>{
  let attempts=0;
  const frames=createFrameQueue({
    settleMs:0,send:async()=>{},capture:()=>{if(++attempts===1)throw Error('Unavailable');return 'recovered'},display:()=>{}
  });
  await assert.rejects(frames.refresh(),/Unavailable/);
  assert.deepEqual(await frames.refresh(),{frameSequence:2,inputSequence:0});
});
"""


if args.self_test:
    subprocess.run(["node", "--input-type=module", "-"], input=(FRAME_QUEUE + FRAME_QUEUE_TEST).encode(), check=True)
else:
    print(f"http://127.0.0.1:{args.port}/?token={token}", flush=True)
    http.server.ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
