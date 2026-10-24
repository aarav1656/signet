#!/usr/bin/env python3
"""capture.py URL OUT.png [--w 1440] [--h 900] [--dpr 2] [--prep JS] [--clip JS] [--wait S] [--pad PX]

Element or region screenshot in the signed-in bhn `deepsurge` profile, in a background tab
(no focus steal, tab closed after). --prep runs in the page before capture (hide chrome,
wrap a sentence in a highlight). --clip is a JS expression returning {x,y,w,h} in document
coordinates (use rect(el)); with no --clip the viewport is captured. Exits 2 and writes
nothing when the page is an error or bot-challenge page or the PNG is visually blank.

  uv run --with websockets --with pillow python3 deck/capture.py URL out.png --clip 'rect(document.querySelector("article"))'
"""
import argparse, asyncio, base64, io, json, subprocess, sys, urllib.request

import websockets
from PIL import Image, ImageStat

ap = argparse.ArgumentParser()
ap.add_argument('url'); ap.add_argument('out')
ap.add_argument('--w', type=int, default=1440); ap.add_argument('--h', type=int, default=900)
ap.add_argument('--dpr', type=float, default=2)
ap.add_argument('--prep', default=''); ap.add_argument('--clip', default='')
ap.add_argument('--wait', type=float, default=3.0); ap.add_argument('--pad', type=int, default=0)
ap.add_argument('--need', default='', help='text that must be present in document.body.innerText')
a = ap.parse_args()

BAD = ("can't be reached", "err_", "access denied", "just a moment", "verify you are human",
       "attention required", "page not found", "this page doesn", "enable javascript", "dns_probe")
RECT = "const rect=(e)=>{const r=e.getBoundingClientRect();return {x:r.left+scrollX,y:r.top+scrollY,w:r.width,h:r.height}};"


def fail(why):
    print(json.dumps({'ok': False, 'url': a.url, 'reason': why}))
    sys.exit(2)


st = subprocess.run(['bhn', 'deepsurge', 'status'], capture_output=True, text=True).stdout
port = [l.split()[1] for l in st.splitlines() if 'RUNNING' in l][-1]


async def new_tab():
    ver = json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/json/version'))
    async with websockets.connect(ver['webSocketDebuggerUrl'], max_size=2 ** 24) as bws:
        await bws.send(json.dumps({'id': 1, 'method': 'Target.createTarget', 'params': {'url': 'about:blank', 'background': True}}))
        while True:
            r = json.loads(await bws.recv())
            if r.get('id') == 1:
                return r['result']['targetId']


tid = asyncio.run(new_tab())


async def main():
    async with websockets.connect(f'ws://127.0.0.1:{port}/devtools/page/{tid}', max_size=2 ** 28) as ws:
        n = 0
        pending = []

        async def cmd(m, p=None):
            nonlocal n
            n += 1
            i = n
            await ws.send(json.dumps({'id': i, 'method': m, 'params': p or {}}))
            while True:
                r = json.loads(await ws.recv())
                if r.get('id') == i:
                    return r
                pending.append(r)

        async def ev(expr):
            r = await cmd('Runtime.evaluate', {'expression': expr, 'returnByValue': True, 'awaitPromise': True})
            if 'exceptionDetails' in r.get('result', {}):
                fail('js error: ' + json.dumps(r['result']['exceptionDetails'])[:300])
            return r['result']['result'].get('value')

        loop = asyncio.get_event_loop()
        await cmd('Page.enable'); await cmd('Network.enable')
        await cmd('Page.setWebLifecycleState', {'state': 'active'})
        await cmd('Emulation.setDeviceMetricsOverride', {'width': a.w, 'height': a.h, 'deviceScaleFactor': a.dpr, 'mobile': False})
        await cmd('Emulation.setFocusEmulationEnabled', {'enabled': True})
        await cmd('Page.navigate', {'url': a.url})
        loaded, last, t0 = False, loop.time(), loop.time()
        while loop.time() - t0 < 40:
            m = pending.pop(0) if pending else None
            if m is None:
                try:
                    m = json.loads(await asyncio.wait_for(ws.recv(), timeout=0.3))
                except asyncio.TimeoutError:
                    m = {}
            if m.get('method') == 'Page.loadEventFired':
                loaded = True
            elif m.get('method') == 'Network.requestWillBeSent':
                last = loop.time()
            if loaded and loop.time() - last > 1.5:
                break
        await ev('document.fonts.ready.then(()=>1)')
        await asyncio.sleep(a.wait)
        body = (await ev('document.title+" || "+document.body.innerText.slice(0,600)') or '').lower()
        if any(b in body[:300] for b in BAD) and len(body) < 900:
            fail('error or challenge page: ' + body[:120])
        if a.need:
            full = await ev('document.body.innerText')
            if a.need.lower().replace('’', "'") not in (full or '').lower().replace('’', "'"):
                fail('required text not on page: ' + a.need)
        if a.prep:
            info = await ev('(()=>{' + RECT + a.prep + '})()')
            await asyncio.sleep(0.6)
            print('prep:', json.dumps(info)[:6000])
        p = {'format': 'png'}
        if a.clip:
            c = await ev('(()=>{' + RECT + 'return (' + a.clip + ')})()')
            if not c or not c.get('w'):
                fail('clip selector matched nothing: ' + a.clip)
            pad = a.pad
            x, y = max(0, c['x'] - pad), max(0, c['y'] - pad)
            p['clip'] = {'x': x, 'y': y, 'width': c['w'] + 2 * pad, 'height': c['h'] + 2 * pad, 'scale': 1}
            p['captureBeyondViewport'] = True
        png = base64.b64decode((await cmd('Page.captureScreenshot', p))['result']['data'])
        im = Image.open(io.BytesIO(png))
        sd = ImageStat.Stat(im.convert('L')).stddev[0]
        if sd < 6:
            fail(f'visually blank (luma stddev {sd:.1f})')
        open(a.out, 'wb').write(png)
        print(json.dumps({'ok': True, 'out': a.out, 'size': im.size, 'stddev': round(sd, 1)}))


try:
    asyncio.run(main())
finally:
    try:
        urllib.request.urlopen(f'http://127.0.0.1:{port}/json/close/{tid}')
    except Exception:
        pass
