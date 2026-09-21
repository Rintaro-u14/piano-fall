const $ = id => document.getElementById(id);
export function setupLibrary({api, post, loadSong, notice, chooseFile, isBusy}) {
  let requestVersion = 0;
  const link = (label, href, className='') => {
    const a = document.createElement('a');
    a.textContent = label; a.href = href; a.target = '_blank';
    a.rel = 'noopener noreferrer'; a.className = className;
    return a;
  };
  const directResults = (result) => {
    $('midiResults').replaceChildren();
    for (const item of result.results || []) {
      const card = document.createElement('article'); card.className = 'midi-result-card';
      const info = document.createElement('div'); info.className = 'midi-result-info';
      const title = document.createElement('strong'); title.textContent = item.name;
      const source = link('配布ページ ↗', item.pageUrl, 'source-fallback');
      info.append(title, source);
      const use = document.createElement('button'); use.type = 'button'; use.className = 'primary midi-use'; use.textContent = 'このMIDIを使う';
      use.onclick = async () => {
        if (isBusy()) { notice('処理が完了してからMIDIを変更してください。'); return; }
        use.disabled = true; const old = use.textContent; use.textContent = '取得中…';
        $('importStatus').textContent = `${item.name} を取得中…`;
        try { await loadSong(() => post('/api/midi-url', {url:item.importUrl || item.pageUrl, pageUrl:item.pageUrl})); }
        finally { use.disabled = false; use.textContent = old; $('importStatus').textContent = ''; }
      };
      card.append(info, use); $('midiResults').append(card);
    }
  };
  async function search() {
    const version = ++requestVersion;
    const query = $('midiQuery').value.trim();
    $('searchStatus').textContent = query ? '複数のMIDI配布サイトを横断検索中…' : '曲名・アーティスト名を入力してください。';
    if (!query) { $('midiResults').replaceChildren(); return; }
    try {
      const result = await api('/api/midi-search?q=' + encodeURIComponent(query));
      if (version !== requestVersion) return;
      directResults(result);
      if (result.results?.length) {
        const partial = result.providerErrors?.length ? '（一部の検索先は応答しませんでした）' : '';
        $('searchStatus').textContent = `「${result.query}」: ${result.results.length}件の候補 ${partial}`;
      } else {
        $('searchStatus').textContent = result.directError || `「${result.query}」の候補は見つかりませんでした。`;
      }
    } catch (error) { $('searchStatus').textContent = error.message; }
  }
  $('findMidi').onclick = () => {
    $('midiLibrary').open = !$('midiLibrary').open;
    if ($('midiLibrary').open) { $('midiLibrary').scrollIntoView({behavior:'smooth',block:'start'}); $('midiQuery').focus({preventScroll:true}); }
  };
  $('midiLibrary').ontoggle = () => $('findMidi').setAttribute('aria-expanded', String($('midiLibrary').open));
  $('midiSearchForm').onsubmit = event => { event.preventDefault(); search(); };
  $('midiQuery').oninput = () => { ++requestVersion; $('midiResults').replaceChildren(); $('searchStatus').textContent = 'Enterまたは「MIDIを検索」で横断検索します。'; };
  $('openSavedMidi').onclick = chooseFile;
  $('midiUrlForm').onsubmit = async event => {
    event.preventDefault();
    if (isBusy()) { notice('処理が完了してからMIDIを変更してください。'); return; }
    const url = $('midiUrl').value.trim();
    $('importStatus').textContent = '配布サイトから取得中…';
    try { await loadSong(() => post('/api/midi-url', {url})); }
    finally { $('importStatus').textContent = ''; }
  };
}
