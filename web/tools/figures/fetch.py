# Download the plates listed in plates.json from Wikimedia Commons as p<plate>.jpg: Commons' own 1920 px
# rendering of each, or its 1280 px one where that is refused. It asks slowly; Commons turns away a client in a hurry.
#   python3 -I tools/figures/fetch.py tools/figures <work dir>
import json, sys, time, urllib.error, urllib.request
src, out = sys.argv[1:]
UA = 'NewtonsCenotaphResearch/1.0 (github.com/davisdilanchian/NewtonsCenotaph)'
for n, p in json.load(open(f'{src}/plates.json')).items():
    url = p['image'].split('?')[0].replace('/commons/', '/commons/thumb/')
    for width in (1920, 1280):
        try:
            data = urllib.request.urlopen(urllib.request.Request(f"{url}/{width}px-{url.rsplit('/', 1)[1]}", headers={'User-Agent': UA})).read()
            open(f'{out}/p{n}.jpg', 'wb').write(data); print(n, width, flush=True)
            break
        except urllib.error.HTTPError as e:
            print(n, width, e.code, flush=True); time.sleep(20)
    time.sleep(5)
