# Download the plates listed in plates.json from Wikimedia Commons, 960 px wide, as f<plate>.jpg.
#   python3 -I tools/figures/fetch.py tools/figures <work dir>
import json, sys, time, urllib.parse, urllib.request
src, out = sys.argv[1:]
UA = 'NewtonsCenotaphResearch/1.0 (github.com/davisdilanchian/NewtonsCenotaph)'
for n, p in json.load(open(f'{src}/plates.json')).items():
    q = urllib.parse.urlencode({'action': 'query', 'titles': 'File:' + p['title'], 'prop': 'imageinfo', 'iiprop': 'url', 'iiurlwidth': 1600, 'format': 'json'})
    page = next(iter(json.load(urllib.request.urlopen(urllib.request.Request('https://commons.wikimedia.org/w/api.php?' + q, headers={'User-Agent': UA})))['query']['pages'].values()))
    data = urllib.request.urlopen(urllib.request.Request(page['imageinfo'][0]['thumburl'], headers={'User-Agent': UA})).read()
    open(f'{out}/f{n}.jpg', 'wb').write(data)
    time.sleep(0.5)
