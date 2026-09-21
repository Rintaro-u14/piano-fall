"""Unified public MIDI search and bounded imports from selected providers."""
from concurrent.futures import ThreadPoolExecutor, as_completed
from email.message import Message
from html.parser import HTMLParser
from pathlib import PurePosixPath
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, unquote, urlencode, urljoin, urlsplit, urlunsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler
import ipaddress
import re
import socket
import threading
import time
import unicodedata

SOURCES = [
    dict(id='bitmidi', name='BitMidi', domain='bitmidi.com', home='https://bitmidi.com/',
         search='https://bitmidi.com/search', param='q'),
    dict(id='midiworld', name='MIDI World', domain='midiworld.com', home='https://www.midiworld.com/files/',
         search='https://www.midiworld.com/search/', param='q'),
    dict(id='midisfree', name='MidisFree', domain='midisfree.com', home='https://midisfree.com/',
         search='https://midisfree.com/', param='s'),
    dict(id='mididb', name='MIDI DB', domain='mididb.com', home='https://www.mididb.com/',
         search='https://www.mididb.com/search.asp', param='q'),
    dict(id='by_cif', name='Midi uploader.jp', domain='uu.getuploader.com', home='https://uu.getuploader.com/by_cif/'),
]

# Hosts are intentionally narrow. getuploader uses several delivery subdomains, but
# every hop is still DNS-checked by public_host() before it is fetched.
IMPORT_DOMAINS = {'bitmidi.com', 'midiworld.com', 'midisfree.com', 'mididb.com'}
MAX_MIDI = 20 * 1024 * 1024
MAX_PAGE = 3 * 1024 * 1024
TIMEOUT = 12
SEARCH_LIMIT = 40
PROVIDER_LIMIT = 15

_UPLOADER_CACHE = {'at': 0.0, 'rows': []}
_UPLOADER_CACHE_LOCK = threading.Lock()


def _host_allowed(host):
    host = (host or '').lower()
    domain = host[4:] if host.startswith('www.') else host
    if domain in IMPORT_DOMAINS:
        return True
    # uploader.jp serves pages from uu/ux/uN and file payloads from dlN.
    return domain == 'getuploader.com' or domain.endswith('.getuploader.com')


def checked_url(value):
    if not isinstance(value, str) or len(value) > 2048 or any(ord(c) < 32 for c in value) or '\\' in value:
        raise ValueError('有効なURLを入力してください。')
    u = urlsplit(value.strip())
    host = (u.hostname or '').lower()
    if u.scheme != 'https' or not _host_allowed(host) or u.username or u.password or u.port not in (None, 443):
        raise ValueError('対応サイトのHTTPS URLを指定してください。その他のサイトは保存したMIDIファイルを読み込めます。')
    return urlunsplit(('https', host, u.path or '/', u.query, ''))


def public_host(url):
    host = urlsplit(url).hostname
    try:
        addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    except OSError as e:
        raise ValueError('配布サイトに接続できません。ネットワークを確認してください。') from e
    if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
        raise ValueError('ローカルネットワークのURLは取り込めません。')


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fetch(url, limit, deadline):
    opener = build_opener(NoRedirect())
    for _ in range(6):
        url = checked_url(url)
        public_host(url)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ValueError('ダウンロードがタイムアウトしました。サイトで保存して読み込んでください。')
        try:
            response = opener.open(Request(url, headers={
                'User-Agent': 'Mozilla/5.0 (compatible; PianoFall/1.2; +local-midi-import)',
                'Accept': 'audio/midi,audio/x-midi,application/octet-stream,text/html,application/xhtml+xml;q=0.8,*/*;q=0.2',
                'Accept-Encoding': 'identity',
            }), timeout=min(TIMEOUT, remaining))
        except HTTPError as e:
            location = e.headers.get('Location')
            code = e.code
            e.close()
            if code in (301, 302, 303, 307, 308) and location:
                url = urljoin(url, location)
                continue
            raise ValueError(f'配布サイトから取得できません（HTTP {code}）。サイトでダウンロードして読み込んでください。') from e
        except (URLError, OSError) as e:
            raise ValueError('配布サイトに接続できません。サイトで保存したMIDIも読み込めます。') from e
        with response:
            length = response.headers.get('Content-Length')
            if length and length.isdecimal() and int(length) > limit:
                raise ValueError('ファイルが大きすぎます。MIDIは20MB以下にしてください。')
            chunks, size = [], 0
            while True:
                if time.monotonic() > deadline:
                    raise ValueError('ダウンロードがタイムアウトしました。')
                chunk = response.read(min(65536, limit + 1 - size))
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
                if size > limit:
                    raise ValueError('取得サイズが上限を超えました。MIDIファイルを指定してください。')
            return b''.join(chunks), url, response.headers
    raise ValueError('転送が多すぎます。最終ダウンロードURLを指定してください。')


def _fetch_html(url, deadline=None):
    deadline = deadline or (time.monotonic() + TIMEOUT)
    content, final, headers = fetch(url, MAX_PAGE, deadline)
    return content.decode('utf-8', errors='replace'), final, headers


def _norm(value):
    value = unicodedata.normalize('NFKC', value or '').casefold()
    return ' '.join(re.findall(r'[\w]+', value, flags=re.UNICODE))


def _query_score(query, name):
    q, n = _norm(query), _norm(name)
    if not q or not n:
        return 0
    if n == q:
        return 100
    if n.startswith(q):
        return 80
    if q in n:
        return 60
    words = [w for w in q.split() if w]
    matched = sum(1 for w in words if w in n)
    return matched * 10


def _row(source, name, page_url, import_url=None, direct=True):
    return {
        'source': source,
        'name': (name or 'Untitled.mid').strip(),
        'pageUrl': page_url,
        'importUrl': import_url or page_url,
        'direct': bool(direct),
    }


class AnchorPage(HTMLParser):
    """Collect anchors plus input/form values that may contain download URLs."""
    def __init__(self):
        super().__init__()
        self.anchors = []
        self.values = []
        self._href = None
        self._text = []
        self.h1 = ''
        self._in_h1 = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'a':
            self._href = attrs.get('href', '')
            self._text = []
            for value in attrs.values():
                if isinstance(value, str):
                    self.values.append(value)
        elif tag == 'input':
            value = attrs.get('value')
            if value:
                self.values.append(value)
        elif tag == 'form':
            action = attrs.get('action')
            if action:
                self.values.append(action)
        elif tag == 'h1':
            self._in_h1 = True

    def handle_data(self, value):
        if self._href is not None:
            self._text.append(value)
        if self._in_h1:
            self.h1 += value

    def handle_endtag(self, tag):
        if tag == 'a' and self._href is not None:
            self.anchors.append((''.join(self._text).strip(), self._href))
            self._href = None
            self._text = []
        elif tag == 'h1':
            self._in_h1 = False


class MidiWorldList(HTMLParser):
    """Extract `track title - download` rows from MIDIWorld list pages."""
    def __init__(self):
        super().__init__()
        self.rows = []
        self._in_li = False
        self._text = []
        self._downloads = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'li':
            self._in_li = True
            self._text = []
            self._downloads = []
        if self._in_li and tag == 'a':
            href = attrs.get('href', '')
            if re.search(r'/download/\d+/?$', urlsplit(href).path):
                self._downloads.append(href)

    def handle_data(self, value):
        if self._in_li:
            self._text.append(value)

    def handle_endtag(self, tag):
        if tag != 'li' or not self._in_li:
            return
        text = ' '.join(''.join(self._text).split())
        text = re.sub(r'\s*-?\s*download\s*$', '', text, flags=re.I).strip(' -')
        for href in self._downloads:
            self.rows.append((text, href))
        self._in_li = False
        self._text = []
        self._downloads = []


def _parse_anchors(html):
    p = AnchorPage()
    p.feed(html)
    return p


def search_sources(query=''):
    if not isinstance(query, str) or len(query) > 160:
        raise ValueError('検索語は160文字以内にしてください。')
    query = query.strip()
    rows = []
    for source in SOURCES:
        fallback = 'https://www.google.com/search?' + urlencode({'q': f'site:{source["domain"]} {query} MIDI'})
        if not query:
            url = source['home']
        elif source['id'] == 'by_cif':
            url = source['home'] + 'search'
        else:
            params = {source.get('param', 'q'): query}
            if source['id'] == 'mididb':
                params['formatID'] = '1'
            url = source['search'] + '?' + urlencode(params)
        rows.append(dict(id=source['id'], name=source['name'], home=source['home'], url=url, fallback=fallback))
    return dict(query=query, sources=rows)


def search_bitmidi(query, limit=PROVIDER_LIMIT):
    html, final, _ = _fetch_html('https://bitmidi.com/search?' + urlencode({'q': query}))
    parser = _parse_anchors(html)
    rows, seen = [], set()
    for title, href in parser.anchors:
        path = urlsplit(href).path.lower()
        if not title.lower().endswith(('.mid', '.midi')) or path.startswith('/search'):
            continue
        # BitMidi search pages can also include generic/popular MIDI links.
        # Keep only rows that actually match the user's query.
        if _query_score(query, title) <= 0:
            continue
        page_url = checked_url(urljoin(final, href))
        if page_url in seen:
            continue
        seen.add(page_url)
        rows.append(_row('BitMidi', title, page_url))
        if len(rows) >= limit:
            break
    return rows


def search_midisfree(query, limit=PROVIDER_LIMIT):
    html, final, _ = _fetch_html('https://midisfree.com/?' + urlencode({'s': query}))
    parser = _parse_anchors(html)
    rows, seen = [], set()
    for title, href in parser.anchors:
        path = urlsplit(href).path.lower()
        if not path.startswith('/download/') or path.startswith('/downloads/'):
            continue
        page_url = checked_url(urljoin(final, href))
        if page_url in seen:
            continue
        # WordPress search pages also contain "Top downloads". Keep results that
        # at least weakly match the user query when a title is available.
        if title and _query_score(query, title) <= 0:
            continue
        seen.add(page_url)
        rows.append(_row('MidisFree', title or unquote(path.rstrip('/').split('/')[-1]) + '.mid', page_url))
        if len(rows) >= limit:
            break
    return rows


def _mididb_song_rows(html, final, query='', source='MIDI DB', limit=PROVIDER_LIMIT):
    parser = _parse_anchors(html)
    rows, seen = [], set()
    for title, href in parser.anchors:
        path = urlsplit(href).path.lower()
        if '-midi/' not in path and not path.endswith('-midi'):
            continue
        # Search/result pages may include unrelated recommendations.
        if query and title and _query_score(query, title) <= 0:
            continue
        page_url = checked_url(urljoin(final, href))
        if page_url in seen:
            continue
        seen.add(page_url)
        rows.append(_row(source, title or unquote(path.rstrip('/').split('/')[-1]), page_url))
        if len(rows) >= limit:
            break
    return rows


def search_mididb(query, limit=PROVIDER_LIMIT):
    url = 'https://www.mididb.com/search.asp?' + urlencode({'q': query, 'formatID': '1'})
    html, final, _ = _fetch_html(url)
    rows = _mididb_song_rows(html, final, query=query, limit=limit)
    if rows:
        return rows
    # Some searches resolve mainly to an artist page. Follow a small number of
    # artist links and then collect the individual song pages.
    parser = _parse_anchors(html)
    for title, href in parser.anchors:
        path = urlsplit(href).path
        if _query_score(query, title) <= 0 or path.count('/') > 2 or path.lower().endswith(('.asp', '.mid', '.midi')):
            continue
        try:
            artist_html, artist_final, _ = _fetch_html(urljoin(final, href))
        except ValueError:
            continue
        rows.extend(_mididb_song_rows(artist_html, artist_final, limit=limit-len(rows)))
        if len(rows) >= limit:
            break
    return rows[:limit]



def _probe_direct_midi(url, deadline=None):
    """Lightweight tri-state probe for direct MIDI endpoints.

    Returns True for an MThd payload, False for a confirmed dead/non-MIDI URL,
    and None for transient/network failures so search results are not discarded
    just because a probe could not complete.
    """
    deadline = deadline or (time.monotonic() + 6)
    opener = build_opener(NoRedirect())
    current = url
    for _ in range(6):
        current = checked_url(current)
        public_host(current)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None
        try:
            response = opener.open(Request(current, headers={
                'User-Agent': 'Mozilla/5.0 (compatible; PianoFall/1.3; +local-midi-import)',
                'Accept': 'audio/midi,audio/x-midi,application/octet-stream,*/*;q=0.2',
                'Accept-Encoding': 'identity',
                'Range': 'bytes=0-3',
            }), timeout=min(6, remaining))
        except HTTPError as e:
            location = e.headers.get('Location')
            code = e.code
            e.close()
            if code in (301, 302, 303, 307, 308) and location:
                current = urljoin(current, location)
                continue
            if code in (404, 410):
                return False
            return None
        except (URLError, OSError):
            return None
        with response:
            return response.read(4) == b'MThd'
    return None


def _filter_live_direct_rows(rows):
    """Drop confirmed-dead direct MIDI links while preserving site result order."""
    if not rows:
        return []
    statuses = [None] * len(rows)
    direct = [(i, row) for i, row in enumerate(rows)
              if re.search(r'/download/\d+/?$', urlsplit(row.get('importUrl', '')).path)]
    if not direct:
        return rows
    with ThreadPoolExecutor(max_workers=min(4, len(direct))) as pool:
        future_map = {pool.submit(_probe_direct_midi, row['importUrl']): i for i, row in direct}
        for future in as_completed(future_map):
            i = future_map[future]
            try:
                statuses[i] = future.result()
            except Exception:
                statuses[i] = None
    return [row for i, row in enumerate(rows) if statuses[i] is not False]

def _midiworld_download_rows(html, final, query='', limit=PROVIDER_LIMIT):
    parser = MidiWorldList()
    parser.feed(html)
    rows, seen = [], set()
    for title, href in parser.rows:
        if query and title and _query_score(query, title) <= 0:
            continue
        download_url = checked_url(urljoin(final, href))
        if download_url in seen:
            continue
        seen.add(download_url)
        rows.append(_row('MIDI World', title or 'MIDI World.mid', final, import_url=download_url))
        if len(rows) >= limit:
            break
    return rows


def search_midiworld(query, limit=PROVIDER_LIMIT):
    # Their dedicated search endpoint is occasionally unavailable. Try it first.
    try:
        html, final, _ = _fetch_html('https://www.midiworld.com/search/?' + urlencode({'q': query}))
        rows = _filter_live_direct_rows(_midiworld_download_rows(html, final, query, limit))
        if rows:
            return rows
    except ValueError:
        pass

    # Stable fallback: find matching artist/composer in the alphabetic index,
    # then read the direct download rows from the artist page.
    q = _norm(query)
    first = next((c.upper() for c in q if 'a' <= c <= 'z'), None)
    if not first:
        return []
    artist_pages = []
    seen_pages = set()
    for page in range(1, 4):
        suffix = '' if page == 1 else str(page)
        url = f'https://www.midiworld.com/files/{first}/all/' + suffix
        try:
            html, final, _ = _fetch_html(url)
        except ValueError:
            continue
        p = _parse_anchors(html)
        for title, href in p.anchors:
            if _query_score(query, title) <= 0:
                continue
            path = urlsplit(href).path
            if not re.fullmatch(r'/files/\d+/?', path):
                continue
            artist_url = checked_url(urljoin(final, href))
            if artist_url not in seen_pages:
                seen_pages.add(artist_url)
                artist_pages.append(artist_url)
        if artist_pages:
            break
    rows = []
    for artist_url in artist_pages[:4]:
        try:
            html, final, _ = _fetch_html(artist_url)
        except ValueError:
            continue
        # Query matched the artist, so keep all tracks from that artist page.
        rows.extend(_midiworld_download_rows(html, final, '', limit-len(rows)))
        if len(rows) >= limit:
            break
    return _filter_live_direct_rows(rows[:limit])


def _uploader_index_page(page):
    url = f'https://uu.getuploader.com/by_cif/index/date/desc/{page}'
    html, final, _ = _fetch_html(url, time.monotonic() + 20)
    parser = _parse_anchors(html)
    rows = []
    for title, href in parser.anchors:
        if not title.lower().endswith(('.mid', '.midi')):
            continue
        if not re.fullmatch(r'/by_cif/download/\d+', urlsplit(urljoin(final, href)).path):
            continue
        rows.append(_row('Midi uploader.jp', title, checked_url(urljoin(final, href))))
    return rows


def _uploader_catalog():
    now = time.monotonic()
    with _UPLOADER_CACHE_LOCK:
        if _UPLOADER_CACHE['rows'] and now - _UPLOADER_CACHE['at'] < 21600:
            return list(_UPLOADER_CACHE['rows'])
    # The collection currently has about 500 files (~35 pages). Fetch pages in
    # parallel and cache the compact MIDI-only index for one hour.
    rows = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(_uploader_index_page, page) for page in range(1, 41)]
        for future in as_completed(futures):
            try:
                rows.extend(future.result())
            except ValueError:
                pass
    dedup = {}
    for row in rows:
        dedup[row['pageUrl']] = row
    rows = list(dedup.values())
    with _UPLOADER_CACHE_LOCK:
        _UPLOADER_CACHE['rows'] = rows
        _UPLOADER_CACHE['at'] = time.monotonic()
    return list(rows)


def search_uploader(query, limit=PROVIDER_LIMIT):
    scored = []
    for row in _uploader_catalog():
        score = _query_score(query, row['name'])
        if score > 0:
            scored.append((-score, _norm(row['name']), row))
    scored.sort(key=lambda x: (x[0], x[1]))
    return [row for _, _, row in scored[:limit]]


SEARCHERS = {
    'BitMidi': search_bitmidi,
    'MIDI World': search_midiworld,
    'MidisFree': search_midisfree,
    'MIDI DB': search_mididb,
    'Midi uploader.jp': search_uploader,
}


def search_library(query=''):
    """Search all supported providers and return one deduplicated candidate list."""
    if not isinstance(query, str) or len(query) > 160:
        raise ValueError('検索語は160文字以内にしてください。')
    query = query.strip()
    payload = search_sources(query)
    payload['results'] = []
    payload['directError'] = None
    payload['providerErrors'] = []
    if not query:
        return payload

    collected = []
    with ThreadPoolExecutor(max_workers=len(SEARCHERS)) as pool:
        futures = {pool.submit(fn, query): name for name, fn in SEARCHERS.items()}
        for future in as_completed(futures):
            name = futures[future]
            try:
                collected.extend(future.result())
            except Exception as e:
                # One provider going down must not break the unified result list.
                payload['providerErrors'].append(name)

    # Deduplicate exact URLs and near-identical names from multiple archives.
    seen_urls, seen_names, ranked = set(), set(), []
    for row in collected:
        url_key = row.get('importUrl') or row['pageUrl']
        name_key = _norm(re.sub(r'\.(?:mid|midi)$', '', row['name'], flags=re.I))
        if url_key in seen_urls:
            continue
        # Preserve alternate arrangements when filenames materially differ, but
        # collapse exact same normalized titles across providers.
        if name_key and name_key in seen_names:
            continue
        seen_urls.add(url_key)
        if name_key:
            seen_names.add(name_key)
        ranked.append((-_query_score(query, row['name']), _norm(row['name']), row))
    ranked.sort(key=lambda x: (x[0], x[1]))
    payload['results'] = [row for _, _, row in ranked[:SEARCH_LIMIT]]
    if not payload['results'] and payload['providerErrors']:
        payload['directError'] = '一部の検索先に接続できませんでした。'
    return payload


def _download_candidates(html, final):
    parser = _parse_anchors(html)
    candidates = []
    for text, href in parser.anchors:
        if not href:
            continue
        absolute = urljoin(final, href)
        u = urlsplit(absolute)
        path = u.path.lower()
        q = parse_qs(u.query)
        label = (text or '').strip().casefold()
        if path.endswith(('.mid', '.midi')) or re.search(r'/midi-download/[^/]+\.(?:mid|midi)$', path):
            candidates.append(absolute)
        elif re.search(r'/download/\d+/?$', path) and absolute != final:
            candidates.append(absolute)
        elif 'wpdmdl' in q or label in {'download', 'download free midi', 'free download'}:
            candidates.append(absolute)
    for raw in parser.values:
        # WordPress Download Manager and uploader.jp may expose the actual URL in
        # a data attribute or readonly input instead of an ordinary anchor.
        for match in re.findall(r'https://[^\s"\'<>]+', raw):
            if '.mid' in match.casefold() or 'wpdmdl=' in match.casefold() or 'getuploader.com' in match.casefold():
                candidates.append(match)
    # Also scan the HTML source for plugin-generated URLs encoded in JS/data attrs.
    for match in re.findall(r'https?://[^\s"\'<>]+', html):
        decoded = match.replace('&amp;', '&')
        low = decoded.casefold()
        if '.mid' in low or 'wpdmdl=' in low or '/midi-download/' in low:
            candidates.append(decoded)
    out, seen = [], set()
    for candidate in candidates:
        try:
            candidate = checked_url(candidate)
        except ValueError:
            continue
        if candidate == final or candidate in seen:
            continue
        seen.add(candidate)
        out.append(candidate)
    return parser.h1.strip(), out


def safe_name(value):
    name = PurePosixPath(value.replace('\\', '/')).name
    name = ''.join(c for c in name if ord(c) >= 32).strip()[:160]
    if not name.lower().endswith(('.mid', '.midi')):
        name += '.mid'
    return name if name not in ('.mid', '.midi') else 'Downloaded.mid'


def download_midi(value):
    """Resolve a provider page/direct URL to validated Standard MIDI bytes."""
    url = checked_url(value)
    deadline = time.monotonic() + 40
    current = url
    title = ''
    headers = {}
    visited = set()

    for _ in range(4):
        content, final, headers = fetch(current, MAX_MIDI, deadline)
        if content.startswith(b'MThd'):
            disposition = Message()
            disposition['content-disposition'] = headers.get('Content-Disposition', '')
            name = safe_name(title or disposition.get_filename() or unquote(urlsplit(final).path.rsplit('/', 1)[-1]))
            return content, name, final
        if len(content) > MAX_PAGE:
            break
        html = content.decode('utf-8', errors='replace')
        page_title, candidates = _download_candidates(html, final)
        title = title or page_title
        candidates = [c for c in candidates if c not in visited]
        visited.add(final)
        # uploader.jp historically exposes a public file URL using the numeric
        # download id and filename. Use it only for the explicitly supported
        # by_cif collection and only after the public page revealed the filename.
        fu = urlsplit(final)
        m = re.fullmatch(r'/by_cif/download/(\d+)', fu.path)
        if not candidates and m and fu.hostname and fu.hostname.endswith('getuploader.com') and title.lower().endswith(('.mid', '.midi')):
            candidates.append(f'https://ux.getuploader.com/by_cif/download/{m.group(1)}/{quote(title)}')
        if not candidates:
            break
        # Prefer URLs that look like actual MIDI payloads, then provider download endpoints.
        candidates.sort(key=lambda c: (
            0 if urlsplit(c).path.lower().endswith(('.mid', '.midi')) else 1,
            0 if '/midi-download/' in urlsplit(c).path.lower() else 1,
            0 if '/download/' in urlsplit(c).path.lower() else 1,
        ))
        current = candidates[0]

    raise ValueError('この配布ページからMIDIを自動取得できませんでした。配布ページで保存した.midを読み込んでください。')
