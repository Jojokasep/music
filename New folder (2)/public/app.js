/* ============================================================
   Jogab Music — SPA frontend
   Streams via the official YouTube IFrame player, metadata via
   the local proxy to YouTube Music, synced lyrics via LRCLIB.
   ============================================================ */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const icon = (id, cls = 'ic') => `<svg class="${cls}"><use href="#${id}"/></svg>`;

const api = async (path) => {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
};

const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const m = Math.floor(s / 60), sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
};

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 2200);
}

function hueFrom(str) {
  let h = 0;
  const s = String(str || 'home');
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}
function applyTint(key) {
  document.documentElement.style.setProperty('--tint', hueFrom(key));
  const main = $('#main');
  if (main) main.style.setProperty('--tint', hueFrom(key));
}
function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}
function updateThemeIcon() {
  const use = $('#theme-ic use');
  if (use) use.setAttribute('href', currentTheme() === 'light' ? '#i-moon' : '#i-sun');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', currentTheme() === 'light' ? '#ebebeb' : '#000000');
}
function toggleTheme() {
  const next = currentTheme() === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  store.set('theme', next);
  updateThemeIcon();
}
function openNowPlaying() {
  $('#nowplaying').classList.remove('hidden');
  document.body.classList.add('np-open');
}
function closeNowPlaying() {
  Player.pending = null;
  $('#nowplaying').classList.add('hidden');
  document.body.classList.remove('np-open');
  renderNowPlaying();
  renderPlayButtons();
  updateLikeButtons();
}
function focusedSong() { return Player.pending || Player.current; }
function isPreviewing() {
  return !!(Player.pending && (!Player.current || Player.pending.videoId !== Player.current.videoId));
}

/* ================= local library (localStorage) ================= */
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('smw_' + k)) ?? d; } catch { return d; } },
  set(k, v) { localStorage.setItem('smw_' + k, JSON.stringify(v)); },
};
const Library = {
  get favorites() { return store.get('fav', []); },
  isFav(id) { return this.favorites.some((s) => s.videoId === id); },
  toggleFav(song) {
    let f = this.favorites;
    if (this.isFav(song.videoId)) { f = f.filter((s) => s.videoId !== song.videoId); toast('Removed from favorites'); }
    else { f.unshift(song); toast('Added to favorites'); }
    store.set('fav', f);
    updateLikeButtons();
    renderSidebarLibrary();
  },
  get playlists() { return store.get('pls', []); },
  createPlaylist(name) {
    const pls = this.playlists;
    const pl = { id: 'local_' + Date.now(), name, tracks: [] };
    pls.unshift(pl); store.set('pls', pls); renderSidebarLibrary(); return pl;
  },
  addToPlaylist(pid, song) {
    const pls = this.playlists;
    const pl = pls.find((p) => p.id === pid);
    if (!pl) return;
    if (!pl.tracks.some((t) => t.videoId === song.videoId)) pl.tracks.push(song);
    store.set('pls', pls);
  },
  removeFromPlaylist(pid, vid) {
    const pls = this.playlists;
    const pl = pls.find((p) => p.id === pid);
    if (!pl) return;
    pl.tracks = pl.tracks.filter((t) => t.videoId !== vid);
    store.set('pls', pls);
  },
  deletePlaylist(pid) { store.set('pls', this.playlists.filter((p) => p.id !== pid)); renderSidebarLibrary(); },
  renamePlaylist(pid, name) {
    const n = String(name || '').trim();
    if (!n) return;
    const pls = this.playlists;
    const pl = pls.find((p) => p.id === pid);
    if (!pl) return;
    pl.name = n;
    store.set('pls', pls);
    renderSidebarLibrary();
  },
  moveInPlaylist(pid, from, dir) {
    const pls = this.playlists;
    const pl = pls.find((p) => p.id === pid);
    if (!pl) return false;
    const to = from + dir;
    if (to < 0 || to >= pl.tracks.length) return false;
    const [item] = pl.tracks.splice(from, 1);
    pl.tracks.splice(to, 0, item);
    store.set('pls', pls);
    return true;
  },
  get saved() { return store.get('sav', []); },
  isSaved(browseId) { return this.saved.some((s) => s.browseId === browseId); },
  toggleSaved(item) {
    let sv = this.saved;
    if (this.isSaved(item.browseId)) { sv = sv.filter((s) => s.browseId !== item.browseId); toast('Removed from library'); }
    else { sv.unshift(item); toast('Saved to library'); }
    store.set('sav', sv);
    renderSidebarLibrary();
  },
  get history() { return store.get('hist', []); },
  pushHistory(song) {
    let h = this.history.filter((s) => s.videoId !== song.videoId);
    h.unshift({ ...song, playedAt: Date.now() });
    store.set('hist', h.slice(0, 100));
    // play stats (local scrobble)
    const st = store.get('stats', {});
    const k = song.videoId;
    if (!st[k]) st[k] = { title: song.title, artist: song.artist || '', thumbnail: song.thumbnail, plays: 0, secs: 0, last: 0 };
    st[k].plays++; st[k].last = Date.now();
    st[k].title = song.title; st[k].thumbnail = song.thumbnail;
    store.set('stats', st);
  },
  get stats() { return store.get('stats', {}); },
  addListenTime(videoId, secs) {
    const st = store.get('stats', {});
    if (st[videoId]) { st[videoId].secs += secs; store.set('stats', st); }
  },
};

/* ================= player state ================= */
const Player = {
  yt: null,
  ready: false,
  queue: [],
  index: -1,
  shuffle: false,
  repeat: 0, // 0 none, 1 all, 2 one
  lyrics: { synced: null, plain: null, source: null, lines: [] },
  lyricsBrowseId: null,
  relatedBrowseId: null,
  sleepTimer: null,
  speed: 1,
  sbSegments: [],
  sbEnabled: store.get('sb_on', true),
  hq: store.get('yt_hq', false), // false = YouTube Music audio, true = YouTube max quality
  quality: 'hd720',
  cued: false,
  pending: null, // song shown in Now Playing while previous track keeps playing
  loadId: 0,
  get current() { return this.queue[this.index] || null; },
};

/* Playback uses the official YouTube IFrame.
   Default: YouTube Music audio version (official audio / ATV) at hd720.
   Quality ON: YouTube max (1080p–4K) for the highest audio bitrate. */
const QUALITY_RANK = ['highres', 'hd2160', 'hd1440', 'hd1080', 'hd720', 'large', 'medium', 'small', 'tiny'];
const qualityRank = (q) => { const i = QUALITY_RANK.indexOf(q); return i < 0 ? 99 : i; };
function bestQuality() {
  if (!Player.yt || !Player.ready || !Player.yt.getAvailableQualityLevels) return 'highres';
  const levels = Player.yt.getAvailableQualityLevels() || [];
  return QUALITY_RANK.find((q) => levels.includes(q)) || levels[0] || 'highres';
}
function suggestedQuality() { return Player.hq ? 'highres' : 'hd720'; }
function applyPlaybackQuality() {
  if (!Player.yt || !Player.ready) return;
  if (Player.hq) {
    const best = bestQuality();
    Player.quality = best;
    try { Player.yt.setSize(1920, 1080); } catch {}
    try { Player.yt.setPlaybackQuality(best); } catch {}
    try { Player.yt.setPlaybackQualityRange(best, best); } catch {}
  } else {
    Player.quality = 'hd720';
    try { Player.yt.setSize(720, 720); } catch {}
    try { Player.yt.setPlaybackQuality('hd720'); } catch {}
    try { Player.yt.setPlaybackQualityRange('hd720', 'hd720'); } catch {}
  }
}
function updateQualityButton() {
  const btn = $('#np-quality');
  if (!btn) return;
  btn.classList.toggle('on', !!Player.hq);
  const span = btn.querySelector('span');
  if (span) span.textContent = Player.hq ? 'Max' : 'Quality';
  btn.title = Player.hq
    ? 'YouTube max quality — tap for YouTube Music audio'
    : 'YouTube Music audio — tap for YouTube max quality';
  document.body.classList.toggle('hq-audio', !!Player.hq);
  syncNpMore();
}
function toggleQuality() {
  Player.hq = !Player.hq;
  store.set('yt_hq', Player.hq);
  updateQualityButton();
  toast(Player.hq ? 'YouTube max quality' : 'YouTube Music audio');
  if (Player.cued || !Player.yt || !Player.ready || !Player.current) {
    applyPlaybackQuality();
    return;
  }
  const t = (Player.yt.getCurrentTime && Player.yt.getCurrentTime()) || 0;
  Player.yt.loadVideoById({
    videoId: Player.current.videoId,
    startSeconds: t,
    suggestedQuality: suggestedQuality(),
  });
  applyPlaybackQuality();
  setTimeout(applyPlaybackQuality, 400);
  setTimeout(applyPlaybackQuality, 1600);
}

window.onYouTubeIframeAPIReady = () => {
  Player.yt = new YT.Player('yt-player', {
    height: '720', width: '720',
    host: 'https://www.youtube.com',
    playerVars: {
      playsinline: 1,
      controls: 0,
      disablekb: 1,
      origin: location.origin,
      modestbranding: 1,
      rel: 0,
      iv_load_policy: 3,
      fs: 0,
      vq: 'hd720',
    },
    events: {
      onReady: () => {
        Player.ready = true;
        const v = store.get('vol', 100);
        Player.yt.setVolume(Number(v));
        applyPlaybackQuality();
        try {
          const iframe = Player.yt.getIframe && Player.yt.getIframe();
          if (iframe) iframe.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share');
        } catch {}
      },
      onStateChange: (e) => {
        if (e.data === YT.PlayerState.ENDED) {
          try {
            const vid = Player.yt.getVideoData && Player.yt.getVideoData().video_id;
            if (vid && Player.current && vid !== Player.current.videoId) return;
          } catch {}
          nextTrack(true);
        }
        if (e.data === YT.PlayerState.PLAYING) {
          setTimeout(maybeRetryLyrics, 600);
          applyPlaybackQuality();
          setTimeout(applyPlaybackQuality, 500);
          setTimeout(applyPlaybackQuality, 2000);
        }
        if (e.data === YT.PlayerState.BUFFERING) applyPlaybackQuality();
        document.body.classList.toggle('paused', e.data !== YT.PlayerState.PLAYING);
        renderPlayButtons();
      },
      onPlaybackQualityChange: (e) => {
        if (!Player.hq) return;
        const best = bestQuality();
        if (e.data && qualityRank(e.data) > qualityRank(best)) applyPlaybackQuality();
      },
      onError: () => { toast('Track unavailable, skipping…'); setTimeout(() => nextTrack(true), 800); },
    },
  });
};
(() => { const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; document.head.appendChild(s); })();

function playSong(song, queue = null, index = null) {
  if (!song || !song.videoId) return;
  song = normalizeSong(song);
  Player.cued = false;
  Player.pending = null;
  if (queue) {
    Player.queue = queue.map((q) => ({ ...normalizeSong(q), _user: false }));
    let idx = index ?? queue.findIndex((q) => q.videoId === song.videoId);
    if (!Number.isFinite(idx) || idx < 0) idx = 0;
    Player.index = idx;
  } else { Player.queue = [{ ...song, _user: false }]; Player.index = 0; }
  startCurrent();
  if (!queue || queue.length <= 1) fetchQueue(song); // build radio queue
}

function userQueueCount() {
  return Player.queue.filter((q, i) => i > Player.index && q._user).length;
}
function alreadyQueued(videoId) {
  return Player.queue.some((q, i) => i > Player.index && q._user && q.videoId === videoId);
}
function queueSong(song, playNext = false) {
  if (!song || !song.videoId) return;
  const s = { ...normalizeSong(song), _user: true };
  if (!Player.current) { playSong(s); return; }
  if (!playNext && alreadyQueued(song.videoId)) {
    toast('Already in your queue');
    renderQueue();
    return;
  }
  if (playNext) {
    Player.queue.splice(Player.index + 1, 0, s);
    toast('Playing next');
  } else {
    let i = Player.index + 1;
    while (i < Player.queue.length && Player.queue[i]._user) i++;
    Player.queue.splice(i, 0, s);
    toast('Added to your queue');
  }
  renderQueue();
}
function removeQueued(i) {
  if (i === Player.index || i < 0 || i >= Player.queue.length) return;
  if (i < Player.index) Player.index--;
  Player.queue.splice(i, 1);
  renderQueue();
}
function clearUserQueue() {
  Player.queue = Player.queue.filter((q, i) => i <= Player.index || !q._user);
  renderQueue();
  toast('Queue cleared');
}
function slimSong(s) {
  if (!s || !s.videoId) return null;
  return {
    videoId: s.videoId,
    title: s.title || '',
    artist: s.artist || s.subtitle || '',
    thumbnail: s.thumbnail || '',
    duration: s.duration || '',
    playlistId: s.playlistId || '',
    _user: !!s._user,
  };
}
function persistQueue() {
  try {
    if (!Player.queue.length) {
      localStorage.removeItem('smw_qstate');
      return;
    }
    const q = Player.queue.map(slimSong).filter(Boolean).slice(0, 80);
    store.set('qstate', {
      queue: q,
      index: Math.min(Math.max(0, Player.index), q.length - 1),
      shuffle: !!Player.shuffle,
      repeat: Player.repeat || 0,
      speed: Player.speed || 1,
    });
  } catch {}
}
function restoreQueue() {
  const st = store.get('qstate', null);
  if (!st || !Array.isArray(st.queue) || !st.queue.length) return false;
  Player.queue = st.queue.map((s) => ({ ...normalizeSong(s), _user: !!s._user }));
  Player.index = Math.min(Math.max(0, Number(st.index) || 0), Player.queue.length - 1);
  Player.shuffle = !!st.shuffle;
  Player.repeat = (st.repeat === 1 || st.repeat === 2) ? st.repeat : 0;
  if (typeof st.speed === 'number' && st.speed > 0) Player.speed = st.speed;
  Player.cued = true;
  Player.pending = null;
  const s = Player.current;
  if (!s) return false;
  const loadId = ++Player.loadId;
  const tryCue = () => {
    if (loadId !== Player.loadId) return;
    if (!Player.ready) return setTimeout(tryCue, 300);
    try {
      Player.yt.cueVideoById({ videoId: s.videoId, suggestedQuality: suggestedQuality() });
      Player.yt.setPlaybackRate(Player.speed);
    } catch {}
  };
  tryCue();
  renderNowPlaying();
  renderQueue();
  updateLikeButtons();
  renderPlayButtons();
  $('#miniplayer').classList.remove('hidden');
  document.body.classList.add('has-player', 'paused');
  document.title = `${s.title} • Jogab Music`;
  applyTint(s.videoId || s.title);
  const shOn = Player.shuffle;
  $('#mini-shuffle') && $('#mini-shuffle').classList.toggle('on', shOn);
  $('#np-shuffle') && $('#np-shuffle').classList.toggle('on', shOn);
  const on = Player.repeat > 0;
  const ic = icon(Player.repeat === 2 ? 'i-repeat-1' : 'i-repeat');
  [$('#mini-repeat'), $('#np-repeat')].forEach((b) => {
    if (!b) return;
    b.classList.toggle('on', on);
    b.innerHTML = ic;
  });
  const sp = $('#np-speed span');
  if (sp) sp.textContent = Player.speed + '×';
  return true;
}
function moveQueued(i, dir) {
  const to = i + dir;
  if (!Number.isFinite(i) || i <= Player.index || to <= Player.index) return;
  if (to >= Player.queue.length) return;
  if (!Player.queue[i] || !Player.queue[i]._user) return;
  if (!Player.queue[to] || !Player.queue[to]._user) return;
  const [item] = Player.queue.splice(i, 1);
  Player.queue.splice(to, 0, item);
  renderQueue();
}

function startCurrent() {
  Player.cued = false;
  Player.pending = null;
  const s = Player.current;
  if (!s) return;
  const loadId = ++Player.loadId;
  const tryPlay = () => {
    if (loadId !== Player.loadId) return;
    if (!Player.ready) return setTimeout(tryPlay, 300);
    Player.yt.loadVideoById({ videoId: s.videoId, suggestedQuality: suggestedQuality() });
    Player.yt.setPlaybackRate(Player.speed);
    Player.yt.playVideo();
    applyPlaybackQuality();
    setTimeout(applyPlaybackQuality, 400);
    setTimeout(applyPlaybackQuality, 1600);
  };
  tryPlay();
  Library.pushHistory(s);
  Player.lyrics = { synced: null, plain: null, source: null, lines: [] };
  Player._lyricsRetried = false;
  Player._lyricsDur = 0;
  lastLyricIdx = -1;
  syncFloatLyric('');
  renderNowPlaying();
  renderQueue();
  updateLikeButtons();
  $('#miniplayer').classList.remove('hidden');
  document.body.classList.add('has-player');
  document.title = `${s.title} • Jogab Music`;
  applyTint(s.videoId || s.title);
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: s.title, artist: s.artist || '',
      artwork: s.thumbnail ? [{ src: s.thumbnail, sizes: '544x544' }] : [],
    });
    navigator.mediaSession.setActionHandler('previoustrack', prevTrack);
    navigator.mediaSession.setActionHandler('nexttrack', () => nextTrack(false));
    navigator.mediaSession.setActionHandler('play', () => Player.yt && Player.yt.playVideo());
    navigator.mediaSession.setActionHandler('pause', () => Player.yt && Player.yt.pauseVideo());
  }
  loadLyrics(s);
  loadSponsorBlock(s.videoId);
  // refresh related tab lazily
  Player.relatedBrowseId = null; // stale — belongs to the previous song until fetchQueue returns
  Player.lyricsBrowseId = null;
  $('#related-list').innerHTML = '<div class="loading-note">Loading…</div>';
  Player._relatedLoaded = false;
  // if the Related tab is currently open, reload it right away for the new song
  if ($('#np-related').classList.contains('active') && !$('#nowplaying').classList.contains('hidden')) {
    setTimeout(() => loadRelated(true), 150);
  }
}

async function fetchQueue(song) {
  const vid = song && song.videoId;
  const loadId = Player.loadId;
  Player._queueFetching = true;
  try {
    const d = await api(`/api/next?videoId=${encodeURIComponent(song.videoId)}${song.playlistId ? `&playlistId=${encodeURIComponent(song.playlistId)}` : ''}`);
    if (Player.cued || loadId !== Player.loadId) return;
    if (!vid || !Player.current || Player.current.videoId !== vid) return;
    Player.lyricsBrowseId = d.lyricsBrowseId;
    Player.relatedBrowseId = d.relatedBrowseId;
    if (d.queue && d.queue.length > 1) {
      const current = Player.current;
      const userUpcoming = Player.queue.filter((q, i) => i > Player.index && q._user);
      const radio = d.queue
        .filter((q) => q.videoId && q.videoId !== (current && current.videoId))
        .filter((q) => !userUpcoming.some((u) => u.videoId === q.videoId))
        .map((q) => ({ ...normalizeSong(q), artist: q.artist, _user: false }));
      Player.queue = [current, ...userUpcoming, ...radio].filter(Boolean);
      Player.index = 0;
      renderQueue();
    }
    if (!Player.lyrics.synced && !Player.lyrics.plain) loadLyrics(Player.current, { silent: true });
  } catch (e) { console.warn('queue fail', e); }
  finally {
    if (loadId === Player.loadId) Player._queueFetching = false;
  }
}

function nextTrack(auto) {
  if (Player.cued) {
    if (auto) return;
    togglePlay();
    return;
  }
  if (Player.repeat === 2 && auto) { Player.yt.seekTo(0); Player.yt.playVideo(); return; }
  if (!Player.queue.length) return;
  let ni;
  if (Player.shuffle) {
    const userNext = Player.queue.findIndex((q, i) => i > Player.index && q._user);
    if (userNext >= 0) ni = userNext;
    else {
      const others = Player.queue.map((_, i) => i).filter((i) => i !== Player.index);
      if (!others.length) {
        if (Player.repeat === 1) ni = Player.index;
        else return;
      } else ni = others[Math.floor(Math.random() * others.length)];
    }
  } else ni = Player.index + 1;
  if (ni >= Player.queue.length) {
    if (Player.repeat === 1) ni = 0;
    else return;
  }
  Player.index = ni;
  startCurrent();
}
function prevTrack() {
  if (Player.cued) { togglePlay(); return; }
  if (Player.yt && Player.yt.getCurrentTime && Player.yt.getCurrentTime() > 4) { Player.yt.seekTo(0); return; }
  if (Player.index > 0) { Player.index--; startCurrent(); }
  else if (Player.yt) Player.yt.seekTo(0);
}
function togglePlay() {
  if (!Player.current) return;
  if (Player.cued) {
    const s = Player.current;
    const hasRadio = Player.queue.some((q, i) => i > Player.index && !q._user);
    startCurrent();
    if (!hasRadio) fetchQueue(s);
    return;
  }
  if (!Player.yt || !Player.ready) return;
  const st = Player.yt.getPlayerState();
  if (st === YT.PlayerState.PLAYING) Player.yt.pauseVideo();
  else Player.yt.playVideo();
}
function playPendingSong() {
  const s = Player.pending;
  if (!s || !s.videoId) return togglePlay();
  Player.pending = null;
  const userUpcoming = Player.queue.filter((q, i) => i > Player.index && q._user);
  Player.queue = [{ ...normalizeSong(s), _user: false }, ...userUpcoming];
  Player.index = 0;
  startCurrent();
  fetchQueue(s);
}
function toggleNowPlayingPlay() {
  if (isPreviewing()) {
    playPendingSong();
    return;
  }
  togglePlay();
}

/* progress loop */
let _lastTick = null;
setInterval(() => {
  if (!Player.yt || !Player.ready || !Player.current || !Player.yt.getDuration) return;
  const cur = Player.yt.getCurrentTime() || 0;
  // local scrobble: accumulate listen time while playing
  const playing = Player.yt.getPlayerState && Player.yt.getPlayerState() === YT.PlayerState.PLAYING;
  const now = Date.now();
  if (playing && _lastTick) Library.addListenTime(Player.current.videoId, Math.min(2, (now - _lastTick) / 1000));
  _lastTick = now;
  // SponsorBlock auto-skip
  if (playing && Player.sbEnabled && Player.sbSegments.length) {
    const seg = Player.sbSegments.find((g) => cur >= g.start && cur < g.end - 0.3);
    if (seg) {
      Player.yt.seekTo(seg.end, true);
      toast(`Skipped ${seg.category.replace('_', ' ')} (SponsorBlock)`);
    }
  }
  const dur = Player.yt.getDuration() || 0;
  const pct = dur ? (cur / dur) * 100 : 0;
  $('#mini-progress-fill').style.width = pct + '%';
  const knob = $('.pb-knob');
  if (knob) knob.style.left = pct + '%';
  $('#mini-cur').textContent = fmtTime(cur);
  $('#mini-dur').textContent = fmtTime(dur);
  if (!isPreviewing() && !seekDragging) {
    $('#np-range').value = dur ? Math.round((cur / dur) * 1000) : 0;
    $('#np-cur').textContent = fmtTime(cur);
    $('#np-dur').textContent = fmtTime(dur);
  }
  if (!isPreviewing()) updateLyricHighlight(cur);
  syncFloatProgress(pct);
  if (Player.floatOn) drawPipFrame(pct);
}, 400);

function renderPlayButtons() {
  const actuallyPlaying = Player.yt && Player.ready && Player.yt.getPlayerState && Player.yt.getPlayerState() === YT.PlayerState.PLAYING;
  const preview = isPreviewing();
  $('#mini-play').innerHTML = icon(actuallyPlaying ? 'i-pause' : 'i-play');
  $('#np-play').innerHTML = icon(!preview && actuallyPlaying ? 'i-pause' : 'i-play');
  const pn = $('#np-playnext');
  const qa = $('#np-queueadd');
  if (pn) pn.classList.toggle('hidden', !preview);
  if (qa) qa.classList.toggle('hidden', !preview);
  syncFloatWidget();
}

/* ================= SponsorBlock / votes / speed / video ================= */
async function loadSponsorBlock(videoId) {
  Player.sbSegments = [];
  try {
    const d = await api(`/api/sponsorblock?videoId=${encodeURIComponent(videoId)}`);
    Player.sbSegments = d.segments || [];
    if (Player.sbSegments.length && Player.sbEnabled) toast(`SponsorBlock: ${Player.sbSegments.length} segment(s) will be skipped`);
  } catch {}
}
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
function cycleSpeed() {
  const i = SPEEDS.indexOf(Player.speed);
  Player.speed = SPEEDS[(i + 1) % SPEEDS.length];
  if (Player.yt && Player.ready) Player.yt.setPlaybackRate(Player.speed);
  $('#np-speed span').textContent = Player.speed + '×';
  persistQueue();
  toast(`Speed: ${Player.speed}×`);
}
function toggleSB() {
  Player.sbEnabled = !Player.sbEnabled;
  store.set('sb_on', Player.sbEnabled);
  $('#np-sb').classList.toggle('on', Player.sbEnabled);
  syncNpMore();
  toast(Player.sbEnabled ? 'SponsorBlock on' : 'SponsorBlock off');
}

/* ================= lyrics ================= */
let lyricsReqId = 0; // guard against out-of-order responses on fast skips
async function loadLyrics(song, { silent = false } = {}) {
  if (!song) return;
  const myReq = ++lyricsReqId;
  const durationSec = (() => {
    if (Player.yt && Player.ready && Player.yt.getDuration) return Math.round(Player.yt.getDuration() || 0);
    return 0;
  })();
  Player._lyricsDur = durationSec;
  const artist = [song.artist, song.artists && song.artists[0] && song.artists[0].name, song.subtitle]
    .map((x) => String(x || '').split('•')[0].replace(/\s*-\s*topic$/i, '').trim())
    .find((x) => x && !looksLikePlays(x)) || '';
  const title = displayTitle(song.title) || song.title;
  if (!silent && !Player.lyrics.synced && !Player.lyrics.plain) {
    $('#lyrics-container').innerHTML = '<div class="lyrics-empty">Looking for lyrics…</div>';
  }
  try {
    const d = await api(`/api/lyrics?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}&duration=${durationSec}&browseId=${encodeURIComponent(Player.lyricsBrowseId || '')}`);
    if (myReq !== lyricsReqId) return; // a newer request superseded us
    // never downgrade: keep existing synced lyrics if the retry found less
    if (Player.lyrics.synced && !d.synced) return;
    Player.lyrics = { ...d, lines: d.synced ? parseLRC(d.synced) : [] };
  } catch {
    if (myReq !== lyricsReqId) return;
    if (!Player.lyrics.synced && !Player.lyrics.plain) Player.lyrics = { synced: null, plain: null, source: null, lines: [] };
  }
  renderLyrics();
}
/* retry once the real duration is known (player loaded after first attempt),
   or when the first attempt found nothing */
function maybeRetryLyrics() {
  const s = Player.current;
  if (!s || !Player.yt || !Player.ready || !Player.yt.getDuration) return;
  const dur = Math.round(Player.yt.getDuration() || 0);
  if (!dur) return;
  const noLyrics = !Player.lyrics.synced && !Player.lyrics.plain;
  const durChanged = Math.abs(dur - (Player._lyricsDur || 0)) > 2;
  if ((noLyrics || (durChanged && !Player.lyrics.synced)) && !Player._lyricsRetried) {
    Player._lyricsRetried = true;
    loadLyrics(s, { silent: true });
  }
}
function parseLRC(lrc) {
  const lines = [];
  for (const raw of String(lrc || '').split('\n')) {
    const m = raw.match(/\[(\d+):(\d+)(?:[.:](\d+))?\](.*)/);
    if (!m) continue;
    const frac = m[3] ? Number(`0.${m[3]}`) : 0;
    lines.push({ t: parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + frac, text: (m[4] || '').trim() });
  }
  return lines.sort((a, b) => a.t - b.t);
}
function renderLyrics() {
  const c = $('#lyrics-container');
  const src = $('#lyrics-source');
  const L = Player.lyrics;
  if (L.lines.length) {
    c.innerHTML = L.lines.map((l, i) => `<div class="lyric-line" data-i="${i}" data-t="${l.t}">${esc(l.text) || '♪'}</div>`).join('');
    $$('.lyric-line', c).forEach((el) => el.addEventListener('click', () => { Player.yt.seekTo(parseFloat(el.dataset.t)); Player.yt.playVideo(); }));
  } else if (L.plain) {
    c.innerHTML = `<div class="lyric-plain">${esc(L.plain)}</div>`;
  } else {
    c.innerHTML = `<div class="lyrics-empty">No lyrics found for this track<br><br>
      <button class="pill-btn" id="lyrics-retry">${icon('i-repeat')}<span>Try again</span></button></div>`;
    const rb = $('#lyrics-retry', c);
    if (rb) rb.addEventListener('click', () => {
      Player._lyricsRetried = false;
      loadLyrics(Player.current);
    });
  }
  src.textContent = L.source ? `Lyrics provided by ${L.source}` : '';
  lastLyricIdx = -1;
  if (L.lines.length) {
    $('#np-lyric-preview').textContent = '';
    syncFloatLyric('');
  } else if (L.plain) {
    const first = String(L.plain).split('\n').map((x) => x.trim()).find(Boolean) || '';
    $('#np-lyric-preview').textContent = first;
    syncFloatLyric(first);
  } else {
    $('#np-lyric-preview').textContent = '';
    syncFloatLyric('');
  }
}
let lastLyricIdx = -1;
function updateLyricHighlight(cur) {
  const L = Player.lyrics;
  if (!L.lines.length) return;
  let idx = -1;
  for (let i = 0; i < L.lines.length; i++) { if (cur >= L.lines[i].t - 0.2) idx = i; else break; }
  if (idx === lastLyricIdx) return;
  lastLyricIdx = idx;
  const c = $('#lyrics-container');
  $$('.lyric-line', c).forEach((el, i) => {
    el.classList.toggle('active', i === idx);
    el.classList.toggle('past', i < idx);
  });
  const active = c.querySelector('.lyric-line.active');
  if (active && $('#np-lyrics').classList.contains('active')) active.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const line = idx >= 0 ? L.lines[idx].text : '';
  $('#np-lyric-preview').textContent = line;
  syncFloatLyric(line);
}

/* ================= now playing UI ================= */
function renderNowPlaying() {
  const mini = Player.current;
  const np = Player.pending || Player.current;
  if (mini) {
    $('#mini-art').src = mini.thumbnail || '';
    const mt = $('#mini-title');
    const ma = $('#mini-artist');
    const title = displayTitle(mini.title) || mini.title || '';
    mt.textContent = title;
    mt.title = title;
    const artist = mini.artist || mini.subtitle || '';
    ma.textContent = artist;
    ma.title = artist;
    ma.classList.toggle('linkish', !!(songArtistBrowseId(mini) || artist.trim()));
  }
  if (!np) return;
  $('#np-art').src = safeCover(np.thumbnail) || COVER_PH;
  $('#np-title').textContent = np.title;
  const artEl = $('#np-artist');
  artEl.textContent = np.artist || np.subtitle || '';
  artEl.classList.toggle('linkish', !!(songArtistBrowseId(np) || (np.artist || '').trim()));
  $('#np-bg').style.backgroundImage = np.thumbnail ? `url("${np.thumbnail}")` : 'none';
  syncFloatWidget();
}
function updateLikeButtons() {
  const mini = Player.current;
  const np = Player.pending || Player.current;
  const miniLiked = mini && Library.isFav(mini.videoId);
  const npLiked = np && Library.isFav(np.videoId);
  $('#mini-like').innerHTML = icon(miniLiked ? 'i-heart-f' : 'i-heart-o');
  $('#mini-like').classList.toggle('liked', !!miniLiked);
  $('#np-like').innerHTML = icon(npLiked ? 'i-heart-f' : 'i-heart-o') + `<span>${npLiked ? 'Favorited' : 'Favorite'}</span>`;
  $('#np-like').classList.toggle('liked', !!npLiked);
  renderSidebarLibrary();
}
function renderSideQueue() {
  const el = $('#side-queue');
  const clr = $('#side-q-clear');
  if (!el) return;
  const n = userQueueCount();
  if (clr) clr.classList.toggle('hidden', n === 0);
  if (!Player.current) {
    el.innerHTML = '<div class="sq-empty">Play a song, then tap the queue icon to add tracks here.</div>';
    return;
  }
  const upcoming = [];
  Player.queue.forEach((q, i) => { if (i > Player.index) upcoming.push({ q, i }); });
  const user = upcoming.filter((x) => x.q._user);
  const now = Player.current;
  let html = `<div class="sq-sec">Now playing</div>
    <button type="button" class="sq-row now" data-qi="${Player.index}">
      ${coverHTML(now.thumbnail, 'sq')}
      <span class="sq-meta"><span class="sq-t">${esc(now.title)}</span><br><span class="sq-s">${esc(now.artist || now.subtitle || '')}</span></span>
    </button>`;
  if (user.length) {
    html += `<div class="sq-sec">Your queue · ${user.length}</div>`;
    html += user.map(({ q, i }, n) => `<button type="button" class="sq-row" data-qi="${i}">
      <span class="sq-n">${n + 1}</span>
      ${coverHTML(q.thumbnail, 'sq')}
      <span class="sq-meta"><span class="sq-t">${esc(q.title)}</span><br><span class="sq-s">${esc(q.artist || q.subtitle || '')}</span></span>
    </button>`).join('');
  } else {
    html += `<div class="sq-empty">Your queue is empty. Tap ${icon('i-queue')} on a song.</div>`;
  }
  el.innerHTML = html;
  $$('.sq-row', el).forEach((b) => b.addEventListener('click', () => {
    const idx = Number(b.dataset.qi);
    if (!Number.isFinite(idx) || idx < 0) return;
    if (idx === Player.index) {
      openNowPlaying();
      switchNPTab('player');
      return;
    }
    Player.index = idx;
    startCurrent();
  }));
}
function updateQueueTab() {
  const n = userQueueCount();
  $$('.np-tab').forEach((t) => {
    if (t.dataset.nptab !== 'queue') return;
    const ic = t.querySelector('svg');
    t.innerHTML = (ic ? ic.outerHTML : icon('i-queue')) + (n ? `Queue · ${n}` : 'Queue');
  });
  [$('#mini-queue'), $('#mini-queue-m')].forEach((b) => {
    if (!b) return;
    b.classList.toggle('has-q', n > 0);
    b.title = n ? `Queue · ${n}` : 'Queue';
  });
}
function renderQueue() {
  updateQueueTab();
  renderSideQueue();
  persistQueue();
  const el = $('#queue-list');
  if (!el) return;
  if (!Player.queue.length) {
    el.innerHTML = `<div class="q-empty">
      <div class="q-empty-title">Queue is empty</div>
      <div class="q-empty-s">Tap the queue icon on any song to add it here. Songs you add play before radio.</div>
    </div>`;
    persistQueue();
    return;
  }
  const upcoming = [];
  Player.queue.forEach((q, i) => { if (i > Player.index) upcoming.push({ q, i }); });
  const user = upcoming.filter((x) => x.q._user);
  const radio = upcoming.filter((x) => !x.q._user);
  const now = Player.current;
  let html = '';
  html += `<div class="q-note">Your queue plays first. Radio fills in after.</div>`;
  if (now) {
    html += `<div class="q-head">Now playing</div>${trackRowHTML({ ...now, qi: Player.index }, true)}`;
  }
  if (user.length) {
    html += `<div class="q-head q-head-row"><span>Your queue · ${user.length}</span><button type="button" class="q-clear" id="q-clear">Clear</button></div>`;
    html += user.map(({ q, i }, n) => {
      const up = n === 0 ? ' disabled' : '';
      const dn = n === user.length - 1 ? ' disabled' : '';
      return trackRowHTML({ ...q, qi: i, qn: n + 1 }, false,
        `<button class="tbtn btn-qup" data-qi="${i}" title="Move up"${up}>${icon('i-chev-up')}</button>` +
        `<button class="tbtn btn-qdn" data-qi="${i}" title="Move down"${dn}>${icon('i-chev-down')}</button>` +
        `<button class="tbtn btn-qrm" data-qi="${i}" title="Remove from queue">${icon('i-x')}</button>`);
    }).join('');
  } else {
    html += `<div class="q-head">Your queue</div><div class="q-hint">Nothing queued yet — tap the queue icon on a song, or Play next on Now Playing.</div>`;
  }
  if (radio.length) {
    html += `<div class="q-head">From radio · ${radio.length}</div>`;
    html += radio.map(({ q, i }) => trackRowHTML({ ...q, qi: i, qRadio: true }, false)).join('');
  }
  el.innerHTML = html;
  $$('.track', el).forEach((row) => {
    let it;
    try { it = JSON.parse(row.dataset.item); } catch { return; }
    row.addEventListener('click', (e) => {
      if (e.target.closest('.tbtn')) return;
      const idx = Number(row.dataset.qi);
      if (Number.isFinite(idx) && idx >= 0) { Player.index = idx; startCurrent(); }
    });
    const favBtn = $('.btn-fav', row);
    if (favBtn) favBtn.addEventListener('click', (e) => { e.stopPropagation(); Library.toggleFav(songFromItem(it)); favBtn.innerHTML = icon(Library.isFav(it.videoId) ? 'i-heart-f' : 'i-heart-o'); });
    const addBtn = $('.btn-addpl', row);
    if (addBtn) addBtn.addEventListener('click', (e) => { e.stopPropagation(); openAddToPlaylist(songFromItem(it)); });
    const qBtn = $('.btn-queue', row);
    if (qBtn) qBtn.addEventListener('click', (e) => { e.stopPropagation(); queueSong(songFromItem(it)); });
    const dlBtn = $('.btn-dl', row);
    if (dlBtn) dlBtn.addEventListener('click', (e) => { e.stopPropagation(); downloadSong(songFromItem(it)); });
    const moreBtn = $('.btn-more', row);
    if (moreBtn) moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const qi = Number(row.dataset.qi);
      openSongMenu(songFromItem(it), { qi: Number.isFinite(qi) ? qi : undefined });
    });
  });
  $$('.btn-qrm', el).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); removeQueued(Number(b.dataset.qi)); } }));
  $$('.btn-qup', el).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); moveQueued(Number(b.dataset.qi), -1); } }));
  $$('.btn-qdn', el).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); moveQueued(Number(b.dataset.qi), 1); } }));
  if (window.matchMedia('(min-width: 861px)').matches) {
    $$('.track.q-user', el).forEach((row) => {
      row.draggable = true;
      row.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', row.dataset.qi);
        e.dataTransfer.effectAllowed = 'move';
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
      row.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; row.classList.add('drag-over'); });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('drag-over');
        const from = Number(e.dataTransfer.getData('text/plain'));
        const to = Number(row.dataset.qi);
        if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return;
        if (from <= Player.index || to <= Player.index) return;
        if (!Player.queue[from] || !Player.queue[from]._user || !Player.queue[to] || !Player.queue[to]._user) return;
        const [item] = Player.queue.splice(from, 1);
        Player.queue.splice(to, 0, item);
        renderQueue();
      });
    });
  }
  const clr = $('#q-clear', el);
  if (clr) clr.addEventListener('click', clearUserQueue);
  persistQueue();
}
async function loadRelated(force = false) {
  const el = $('#related-list');
  if (!el) return;
  const song = Player.current;
  if (!song) { el.innerHTML = '<div class="loading-note">Play a song first</div>'; return; }
  if (Player._relatedLoaded && !force) return;
  Player._relatedLoaded = true;
  el.innerHTML = '<div class="loading-note">Loading…</div>';

  const vid = song.videoId;
  const sameSong = () => Player.current && Player.current.videoId === vid;

  for (let i = 0; i < 16 && !Player.relatedBrowseId && sameSong(); i++) {
    await new Promise((r) => setTimeout(r, 300));
    if (!Player._queueFetching && i >= 3 && !Player.relatedBrowseId) break;
  }
  if (!sameSong()) { Player._relatedLoaded = false; return; }

  const renderFail = () => {
    Player._relatedLoaded = false;
    el.innerHTML = `<div class="loading-note">Couldn't load related content<br><br>
      <button class="pill-btn" id="related-retry">${icon('i-repeat')}<span>Try again</span></button></div>`;
    const rb = $('#related-retry', el);
    if (rb) rb.addEventListener('click', () => loadRelated(true));
  };

  const paint = (html) => {
    if (!sameSong()) { Player._relatedLoaded = false; return false; }
    el.innerHTML = html;
    bindItems(el);
    return true;
  };

  if (Player.relatedBrowseId) {
    try {
      const d = await api(`/api/related?browseId=${encodeURIComponent(Player.relatedBrowseId)}`);
      if (d.sections && d.sections.length) {
        paint(relatedSectionsHTML(d.sections));
        return;
      }
    } catch {}
  }
  if (!sameSong()) { Player._relatedLoaded = false; return; }

  try {
    const d = await api(`/api/next?videoId=${encodeURIComponent(vid)}`);
    if (!sameSong()) { Player._relatedLoaded = false; return; }
    if (d.relatedBrowseId) Player.relatedBrowseId = d.relatedBrowseId;
    if (Player.relatedBrowseId) {
      try {
        const rel = await api(`/api/related?browseId=${encodeURIComponent(Player.relatedBrowseId)}`);
        if (rel.sections && rel.sections.length) {
          paint(relatedSectionsHTML(rel.sections));
          return;
        }
      } catch {}
    }
    const items = (d.queue || [])
      .filter((q) => q.videoId && q.videoId !== vid)
      .slice(0, 25)
      .map((q) => ({ type: 'song', videoId: q.videoId, title: q.title, subtitle: q.artist, thumbnail: q.thumbnail, duration: q.duration, artists: q.artists }));
    if (items.length) {
      paint(shelfHTML({ title: 'Similar songs', items, list: true }));
      return;
    }
  } catch {}
  if (sameSong()) renderFail();
}

/* ================= download (via converter service, direct save) ================= */
const activeDownloads = new Set();
function downloadFilename(song) {
  const t = displayTitle(song && song.title) || 'track';
  const a = String((song && song.artist) || '').split(',')[0].trim();
  const raw = (a ? `${a} - ${t}` : t).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  return `${raw.slice(0, 80) || 'track'}.mp3`;
}
function clickDownload(href, name) {
  const aEl = document.createElement('a');
  aEl.href = href;
  aEl.download = name || '';
  aEl.target = '_blank';
  aEl.rel = 'noopener noreferrer';
  document.body.appendChild(aEl);
  aEl.click();
  aEl.remove();
}
async function downloadSong(song) {
  if (!song || !song.videoId) return;
  if (activeDownloads.has(song.videoId)) { toast('Already downloading this song…'); return; }
  activeDownloads.add(song.videoId);
  toast(`Preparing "${song.title}" (320kbps MP3)…`);
  try {
    const st = await api(`/api/download-start?videoId=${encodeURIComponent(song.videoId)}`);
    if (!st.progressUrl) throw new Error('no progress url');
    let url = null;
    let lastProg = -1;
    for (let i = 0; i < 60; i++) {
      if (i) await new Promise((r) => setTimeout(r, 2500));
      try {
        const p = await api(`/api/download-progress?progressUrl=${encodeURIComponent(st.progressUrl)}`);
        if (p.done && p.url) { url = p.url; break; }
        const raw = Number(p.progress) || 0;
        const pct = Math.min(99, raw > 100 ? Math.round(raw / 10) : Math.round(raw));
        if (pct !== lastProg) {
          lastProg = pct;
          toast(pct <= 5 && p.text ? String(p.text) : `Converting "${song.title}"… ${pct}%`);
        }
      } catch {}
    }
    if (!url) throw new Error('timeout');
    toast(`Downloading "${song.title}"…`);
    const name = downloadFilename(song);
    try {
      const r = await fetch(url, { mode: 'cors' });
      if (!r.ok) throw new Error('fetch');
      const blob = await r.blob();
      const obj = URL.createObjectURL(blob);
      clickDownload(obj, name);
      setTimeout(() => URL.revokeObjectURL(obj), 8000);
    } catch {
      clickDownload(url, name);
    }
    toast('Download started');
  } catch (e) {
    toast('Download failed — try again later');
  } finally {
    activeDownloads.delete(song.videoId);
  }
}

/* ================= rendering helpers ================= */
function looksLikePlays(s) {
  return /pemutaran|plays|ditonton|views|x ditonton/i.test(String(s || ''));
}
function normalizeDuration(s) {
  const t = String(s || '').trim();
  if (/^\d{1,2}(\.\d{2}){1,2}$/.test(t)) return t.replace(/\./g, ':');
  return t;
}
function displayTitle(t) {
  const raw = String(t || '').trim();
  if (!raw) return '';
  const cleaned = raw
    .replace(/\s*[\(\[]\s*official\s*(hd\s*)?(4k\s*)?(music\s*)?(lyric(s)?\s*)?(audio|video|visualizer|mv)[^\)\]]*[\)\]]/gi, '')
    .replace(/\s*[\(\[]\s*(official\s*)?(hd\s*)?(music\s*)?(lyric(s)?\s*)?(audio|video|visualizer|mv)[^\)\]]*[\)\]]/gi, '')
    .replace(/\s*[\(\[]\s*(official\s*)?(4k|hd|hq|8d(?:\s*audio)?|1080p|720p)\s*[\)\]]/gi, '')
    .replace(/\s*-\s*(official|lyric(s)?|audio|video|visualizer|topic).*$/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cleaned || raw;
}
function normalizeSong(s) {
  if (!s) return s;
  return { ...s, title: displayTitle(s.title) };
}
function songFromItem(it) {
  const artists = it.artists || [];
  const artistBrowseId = it.artistBrowseId || (artists[0] && artists[0].browseId) || '';
  const fromArr = artists.map((a) => a.name).filter(Boolean).join(', ');
  const artist = fromArr || it.artist || (looksLikePlays(it.subtitle) ? '' : (it.subtitle || ''));
  return normalizeSong({
    videoId: it.videoId, title: it.title,
    artist,
    artistBrowseId,
    thumbnail: it.thumbnail, duration: normalizeDuration(it.duration), playlistId: it.playlistId,
  });
}
const COVER_PH = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><rect width="80" height="80" fill="#242424"/><path fill="#6a6a6a" d="M32 24v26.6a7 7 0 1 0 4 6.4V32h14V24H32z"/></svg>'
);
function safeCover(src) {
  const u = String(src || '').trim();
  if (!u || u === 'undefined' || u === 'null' || u === 'about:blank') return '';
  return u;
}
function coverHTML(src, kind = '') {
  const u = safeCover(src);
  if (!u) return `<div class="art-ph${kind ? ' art-ph-' + kind : ''}">${icon('i-note')}</div>`;
  return `<img loading="lazy" src="${esc(u)}" alt="">`;
}
function cardHTML(it) {
  const cls = it.type === 'artist' ? 'card artist' : 'card';
  return `<div class="${cls}" data-item='${esc(JSON.stringify(it))}'>
    <div class="art">${coverHTML(it.thumbnail)}<div class="play-ov">${icon('i-play')}</div></div>
    <div class="t">${esc(it.title)}</div><div class="s">${esc(it.subtitle || '')}</div>
  </div>`;
}
function trackRowHTML(it, playing = false, extraBtn = '') {
  const qi = it.qi != null ? ` data-qi="${it.qi}"` : '';
  const pl = it.plId ? ` data-pl="${esc(it.plId)}" data-pi="${it.plIndex}"` : '';
  const qn = it.qn ? `<span class="q-num">${it.qn}</span>` : '';
  const tn = it.tn != null ? `<span class="t-num">${it.tn}</span>` : '';
  const cls = `track${playing ? ' playing' : ''}${it.qRadio ? ' q-radio' : ''}${it.qn ? ' q-user' : ''}${it.plId ? ' pl-track' : ''}`;
  return `<div class="${cls}"${qi}${pl} data-item='${esc(JSON.stringify(it))}'>
    <span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>
    ${tn}${qn}
    ${coverHTML(it.thumbnail, 'track')}
    <div class="tmeta"><div class="tt">${esc(displayTitle(it.title))}</div><div class="ts">${esc(it.artist || it.subtitle || '')}</div></div>
    ${it.duration ? `<span class="tdur">${esc(it.duration)}</span>` : ''}
    <button class="tbtn btn-fav" title="Favorite">${icon(Library.isFav(it.videoId) ? 'i-heart-f' : 'i-heart-o')}</button>
    <button class="tbtn btn-queue" title="Add to queue">${icon('i-queue')}</button>
    <button class="tbtn btn-addpl" title="Add to playlist">${icon('i-plus')}</button>
    <button class="tbtn btn-dl" title="Download">${icon('i-download')}</button>
    <button class="tbtn btn-more" title="More">${icon('i-more')}</button>
    ${extraBtn}
  </div>`;
}
function trackHeadHTML() {
  return `<div class="track-head" aria-hidden="true"><span class="th-n">#</span><span class="th-t">Title</span><span class="th-d">Time</span></div>`;
}
function quickCardHTML(it) {
  return `<button class="quick-card" data-item='${esc(JSON.stringify(it))}'>
    ${coverHTML(it.thumbnail, 'quick')}
    <span class="qc-t">${esc(it.title)}</span>
    <span class="play-ov">${icon('i-play')}</span>
  </button>`;
}
function carouselHTML(inner) {
  return `<div class="carousel-wrap">
    <button type="button" class="car-btn car-prev" aria-label="Scroll left">${icon('i-back')}</button>
    <div class="carousel">${inner}</div>
    <button type="button" class="car-btn car-next" aria-label="Scroll right">${icon('i-fwd')}</button>
  </div>`;
}
function emptyHTML(title, sub, opts = {}) {
  const ic = opts.ic || 'i-note';
  const cta = opts.label
    ? `<button type="button" class="pill-btn primary empty-cta"${opts.go ? ` data-go="${esc(opts.go)}"` : ''}${opts.act ? ` data-act="${esc(opts.act)}"` : ''}>${opts.label}</button>`
    : '';
  return `<div class="empty-block">
    <div class="empty-ic">${icon(ic)}</div>
    <div class="empty-title">${title}</div>
    <div class="empty-s">${sub}</div>
    ${cta}
  </div>`;
}
function likedCardHTML() {
  const n = Library.favorites.length;
  return `<div class="card liked-card" data-nav="#/library/favorites">
    <div class="art liked-cover">${icon('i-heart-f', 'ic liked-heart')}<div class="play-ov">${icon('i-play')}</div></div>
    <div class="t">Liked Songs</div>
    <div class="s">${n} song${n === 1 ? '' : 's'}</div>
  </div>`;
}
function shelfHTML(sec) {
  if (sec.list) {
    return `<div class="shelf"><div class="shelf-title">${esc(sec.title)}</div>
      <div class="track-list">${sec.items.map((i) => (i.videoId ? trackRowHTML(i) : cardHTML(i))).join('')}</div></div>`;
  }
  return `<div class="shelf"><div class="shelf-title">${esc(sec.title)}</div>
    ${carouselHTML(sec.items.map(cardHTML).join(''))}</div>`;
}
function bindCarousels(root) {
  $$('.carousel-wrap', root).forEach((wrap) => {
    const sc = $('.carousel', wrap);
    const prev = $('.car-prev', wrap);
    const next = $('.car-next', wrap);
    const step = 400;
    const scrollBy = (dir) => { sc.scrollLeft += dir * step; updateCarBtns(); };
    const updateCarBtns = () => {
      prev.classList.toggle('off', sc.scrollLeft < 10);
      next.classList.toggle('off', sc.scrollLeft + sc.clientWidth >= sc.scrollWidth - 10);
    };
    prev.addEventListener('click', () => scrollBy(-1));
    next.addEventListener('click', () => scrollBy(1));
    sc.addEventListener('scroll', updateCarBtns, { passive: true });
    updateCarBtns();
  });
}
function bindItems(root) {
  $$('.card, .quick-card, .mood-card', root).forEach((el) => {
    el.addEventListener('click', () => {
      let it;
      try { it = JSON.parse(el.dataset.item); } catch { return; }
      const nav = el.dataset.nav;
      if (nav) { router.go(nav); return; }
      handleItemClick(it);
    });
  });
  bindCarousels(root);
}
function relatedSectionsHTML(sections) {
  return sections.map((s) => shelfHTML(s)).join('');
}
function handleItemClick(it) {
  if (!it) return;
  if (it.videoId) { playSong(songFromItem(it)); return; }
  if (it.browseId) { router.go(`#/browse/${it.browseId}${it.params ? '?params=' + encodeURIComponent(it.params) : ''}`); return; }
  if (it.playlistId && !it.browseId) {
    if (it.watchPlaylist) { router.go(`#/browse/VL${it.playlistId}`); return; }
    router.go(`#/browse/VL${it.playlistId}`);
    return;
  }
}
function songArtistBrowseId(song) {
  if (song.artistBrowseId) return song.artistBrowseId;
  if (song.artists && song.artists[0] && song.artists[0].browseId) return song.artists[0].browseId;
  return '';
}

/* ================= sidebar ================= */
const NAV = [
  { id: 'home', icon: 'i-home', label: 'Home', hash: '#/' },
  { id: 'search', icon: 'i-search', label: 'Search', hash: '#/search' },
  { id: 'library', icon: 'i-library', label: 'Your Library', hash: '#/library' },
];
function renderNav() {
  const desk = $('#nav-desktop');
  const mob = $('#nav-mobile');
  if (desk) desk.innerHTML = NAV.map((n) => `<button class="nav-item" data-nav="${n.hash}">${icon(n.icon)}<span>${n.label}</span></button>`).join('');
  if (mob) mob.innerHTML = NAV.map((n) => `<button class="mob-item" data-nav="${n.hash}">${icon(n.icon)}<span>${n.label}</span></button>`).join('');
  [desk, mob].forEach((el) => {
    if (!el) return;
    $$('.nav-item, .mob-item', el).forEach((b) => b.addEventListener('click', () => router.go(b.dataset.nav)));
  });
}
function renderSidebarLibrary() {
  const el = $('#lib-list');
  if (!el) return;
  const saved = Library.saved;
  const pls = Library.playlists;
  let html = '';
  // liked songs
  html += `<div class="lib-row" data-nav="#/library/favorites">
    <div class="lib-ph liked-ph">${icon('i-heart-f')}</div>
    <div class="lr-meta"><div class="lr-t">Liked Songs</div><div class="lr-s">${Library.favorites.length} songs</div></div>
  </div>`;
  // saved items
  for (const s of saved.slice(0, 30)) {
    const round = s.type === 'artist' ? ' round' : '';
    html += `<div class="lib-row${round}" data-nav="#/browse/${s.browseId}">
      ${coverHTML(s.thumbnail, 'lib')}
      <div class="lr-meta"><div class="lr-t">${esc(s.title)}</div><div class="lr-s">${esc(s.subtitle || s.type || '')}</div></div>
    </div>`;
  }
  // playlists
  for (const p of pls) {
    const thumb = p.tracks[0] && p.tracks[0].thumbnail ? p.tracks[0].thumbnail : '';
    html += `<div class="lib-row" data-nav="#/playlist/${p.id}">
      ${coverHTML(thumb, 'lib')}
      <div class="lr-meta"><div class="lr-t">${esc(p.name)}</div><div class="lr-s">${p.tracks.length} songs</div></div>
    </div>`;
  }
  if (!saved.length && !pls.length) {
    html += `<div class="lib-empty">Items you save will appear here.<br><b>Your Library</b> makes it easy to find your favorites.</div>`;
  }
  el.innerHTML = html;
  $$('.lib-row', el).forEach((r) => r.addEventListener('click', () => {
    const nav = r.dataset.nav;
    if (nav) router.go(nav);
  }));
}

/* ================= router / pages ================= */
const router = {
  _hash: '',
  _stack: [],
  go(hash) { location.hash = hash; },
  back() {
    if (this._stack.length > 1) {
      this._stack.pop();
      location.hash = this._stack[this._stack.length - 1] || '#/';
    } else {
      location.hash = '#/';
    }
  },
  fwd() {
    // not a real fwd — just go home
    location.hash = '#/';
  },
  _onHash() {
    let h = location.hash || '#/';
    if (h !== this._hash) {
      this._hash = h;
      if (this._stack[this._stack.length - 1] !== h) this._stack.push(h);
      if (this._stack.length > 50) this._stack = this._stack.slice(-50);
      this._render();
    }
    this._updateNav();
  },
  _updateNav() {
    const h = this._hash;
    const active = h.startsWith('#/search') ? 'search' : h.startsWith('#/library') || h.startsWith('#/playlist') ? 'library' : 'home';
    $$('.nav-item', $('#nav-desktop')).forEach((b) => b.classList.toggle('active', b.dataset.nav === '#/' && active === 'home' || b.dataset.nav === '#/search' && active === 'search' || b.dataset.nav === '#/library' && active === 'library'));
    $$('.mob-item', $('#nav-mobile')).forEach((b) => b.classList.toggle('active', b.dataset.nav === '#/' && active === 'home' || b.dataset.nav === '#/search' && active === 'search' || b.dataset.nav === '#/library' && active === 'library'));
    $('#nav-back').disabled = this._stack.length <= 1;
  },
  async _render() {
    const h = this._hash;
    const view = $('#view');
    view.classList.remove('view-enter');
    void view.offsetWidth; // reflow
    view.classList.add('view-enter');
    view.scrollTop = 0;
    $('#main').scrollTop = 0;
    if (h === '#/' || h === '') { await renderHome(view); }
    else if (h === '#/search') { renderSearchPage(view); }
    else if (h === '#/library') { renderLibraryPage(view); }
    else if (h === '#/library/favorites') { renderFavoritesPage(view); }
    else if (h === '#/library/stats') { renderStatsPage(view); }
    else if (h.startsWith('#/browse/')) {
      const parts = h.replace('#/browse/', '').split('?');
      const id = parts[0];
      const params = new URLSearchParams(parts[1] || '').get('params') || '';
      await renderBrowsePage(view, id, params);
    }
    else if (h.startsWith('#/playlist/')) {
      const pid = h.replace('#/playlist/', '');
      renderLocalPlaylistPage(view, pid);
    }
    else { view.innerHTML = emptyHTML('Page not found', 'Try going home.', { label: 'Go Home', go: '#/' }); bindItems(view); }
  },
};
window.addEventListener('hashchange', () => router._onHash());

/* ---- home page ---- */
async function renderHome(el) {
  try {
    const d = await api('/api/home');
    let html = '';
    // greeting
    const hour = new Date().getHours();
    const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    html += `<div class="hello-row"><div><div class="greeting">${greet}</div><div class="page-title">Welcome to Jogab Music</div></div></div>`;
    // quick grid from first section (recently played)
    if (d.sections && d.sections[0] && d.sections[0].items && d.sections[0].items.length >= 4) {
      const items = d.sections[0].items.slice(0, 8);
      html += `<div class="quick-grid">${items.map(quickCardHTML).join('')}</div>`;
      d.sections = d.sections.slice(1);
    } else {
      // fallback: favorites as quick cards
      const favs = Library.favorites.slice(0, 8);
      if (favs.length >= 4) {
        html += `<div class="quick-grid">${favs.map((s) => quickCardHTML({ ...s, title: displayTitle(s.title) })).join('')}</div>`;
      }
    }
    // rest as shelves
    for (const sec of d.sections || []) {
      html += shelfHTML(sec);
    }
    el.innerHTML = html;
    bindItems(el);
  } catch (e) {
    el.innerHTML = emptyHTML('Failed to load home', e.message, { label: 'Retry', act: 'reload-home' });
    bindItems(el);
  }
}

/* ---- search page ---- */
let searchDebounce = null;
let searchAbort = null;
function renderSearchPage(el) {
  el.innerHTML = `
    <div class="page-title">Search</div>
    <div class="search-bar">
      ${icon('i-search')}
      <input type="text" id="search-input" placeholder="What do you want to listen to?" autocomplete="off" autofocus />
      <button type="button" id="search-clear" class="icon-btn" style="display:none">${icon('i-x')}</button>
    </div>
    <div id="search-suggest"></div>
    <div id="search-results"></div>
  `;
  const input = $('#search-input');
  const clearBtn = $('#search-clear');
  const suggestEl = $('#search-suggest');
  const resultsEl = $('#search-results');
  const doSearch = async (q) => {
    q = String(q || '').trim();
    if (!q) { suggestEl.innerHTML = ''; resultsEl.innerHTML = ''; clearBtn.style.display = 'none'; return; }
    clearBtn.style.display = '';
    // suggestions
    try {
      const sg = await api(`/api/suggest?q=${encodeURIComponent(q)}`);
      if (sg.suggestions && sg.suggestions.length) {
        suggestEl.innerHTML = `<div class="suggest">${sg.suggestions.slice(0, 6).map((s) => `<button type="button" data-sq="${esc(s)}">${esc(s)}</button>`).join('')}</div>`;
        $$('.suggest button', suggestEl).forEach((b) => b.addEventListener('click', () => { input.value = b.dataset.sq; doSearch(b.dataset.sq); }));
      } else { suggestEl.innerHTML = ''; }
    } catch { suggestEl.innerHTML = ''; }
    // results
    try {
      const d = await api(`/api/search?q=${encodeURIComponent(q)}`);
      resultsEl.innerHTML = (d.sections || []).map(shelfHTML).join('');
      bindItems(resultsEl);
    } catch {
      resultsEl.innerHTML = '<div class="empty-note">Search failed. Try again.</div>';
    }
  };
  input.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    const v = input.value;
    searchDebounce = setTimeout(() => doSearch(v), 350);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(searchDebounce); doSearch(input.value); } });
  clearBtn.addEventListener('click', () => { input.value = ''; doSearch(''); input.focus(); });
  input.focus();
}

/* ---- library page ---- */
function renderLibraryPage(el) {
  const saved = Library.saved;
  const pls = Library.playlists;
  let html = `<div class="hello-row"><div class="page-title">Your Library</div></div>`;
  if (saved.length || pls.length) {
    html += `<div class="lib-grid">`;
    // liked
    html += `<div class="card liked-card" data-nav="#/library/favorites">
      <div class="art liked-cover">${icon('i-heart-f', 'ic liked-heart')}<div class="play-ov">${icon('i-play')}</div></div>
      <div class="t">Liked Songs</div>
      <div class="s">${Library.favorites.length} songs</div>
    </div>`;
    for (const s of saved) {
      const round = s.type === 'artist' ? ' artist' : '';
      html += `<div class="card${round}" data-item='${esc(JSON.stringify(s))}'>
        <div class="art">${coverHTML(s.thumbnail)}<div class="play-ov">${icon('i-play')}</div></div>
        <div class="t">${esc(s.title)}</div><div class="s">${esc(s.subtitle || '')}</div>
      </div>`;
    }
    for (const p of pls) {
      const thumb = p.tracks[0] && p.tracks[0].thumbnail ? p.tracks[0].thumbnail : '';
      html += `<div class="card" data-nav="#/playlist/${p.id}">
        <div class="art">${coverHTML(thumb)}<div class="play-ov">${icon('i-play')}</div></div>
        <div class="t">${esc(p.name)}</div>
        <div class="s">${p.tracks.length} songs</div>
      </div>`;
    }
    html += `</div>`;
  } else {
    html += emptyHTML('Your library is empty', 'Save albums, artists, and playlists to find them here.');
  }
  html += `<div style="margin-top:24px"><button class="pill-btn" data-act="create-pl">${icon('i-plus')}<span>Create Playlist</span></button></div>`;
  if (Library.favorites.length) {
    html += `<div style="margin-top:8px"><button class="pill-btn" data-act="stats">${icon('i-chart')}<span>Listening Stats</span></button></div>`;
  }
  el.innerHTML = html;
  bindItems(el);
  const createBtn = $('[data-act="create-pl"]', el);
  if (createBtn) createBtn.addEventListener('click', openCreatePlaylist);
  const statsBtn = $('[data-act="stats"]', el);
  if (statsBtn) statsBtn.addEventListener('click', () => router.go('#/library/stats'));
}

/* ---- favorites page ---- */
function renderFavoritesPage(el) {
  const favs = Library.favorites;
  if (!favs.length) {
    el.innerHTML = emptyHTML('No favorites yet', 'Songs you favorite will appear here.');
    return;
  }
  let html = `<div class="detail-head">
    <div class="detail-ph">${icon('i-heart-f')}</div>
    <div class="detail-info">
      <div class="detail-kicker">Playlist</div>
      <h1>Liked Songs</h1>
      <div class="sub">${favs.length} songs</div>
      <div class="detail-actions">
        <button class="pill-btn primary" data-act="play-fav">${icon('i-play')}<span>Play</span></button>
        <button class="pill-btn" data-act="shuffle-fav">${icon('i-shuffle')}<span>Shuffle</span></button>
      </div>
    </div>
  </div>`;
  html += trackHeadHTML();
  html += `<div class="track-list">${favs.map((s, i) => trackRowHTML({ ...s, tn: i + 1, plId: 'fav', plIndex: i })).join('')}</div>`;
  el.innerHTML = html;
  bindTrackList(el, favs, 'fav');
  const playBtn = $('[data-act="play-fav"]', el);
  if (playBtn) playBtn.addEventListener('click', () => playSong(songFromItem(favs[0]), favs.map(songFromItem), 0));
  const shuffleBtn = $('[data-act="shuffle-fav"]', el);
  if (shuffleBtn) shuffleBtn.addEventListener('click', () => { Player.shuffle = true; playSong(songFromItem(favs[Math.floor(Math.random() * favs.length)]), favs.map(songFromItem)); });
}

/* ---- stats page ---- */
function renderStatsPage(el) {
  const stats = Library.stats;
  const entries = Object.entries(stats).sort((a, b) => b[1].plays - a[1].plays);
  const totalPlays = entries.reduce((s, [, v]) => s + v.plays, 0);
  const totalSecs = entries.reduce((s, [, v]) => s + (v.secs || 0), 0);
  const hours = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  let html = `<div class="page-title">Listening Stats</div>`;
  html += `<div class="stats-cards">
    <div class="stat-card"><div class="stat-num">${entries.length}</div><div class="stat-lbl">Unique songs</div></div>
    <div class="stat-card"><div class="stat-num">${totalPlays}</div><div class="stat-lbl">Total plays</div></div>
    <div class="stat-card"><div class="stat-num">${hours}h ${mins}m</div><div class="stat-lbl">Listen time</div></div>
  </div>`;
  if (entries.length) {
    html += `<div class="page-title" style="font-size:20px;margin-top:16px">Most Played</div>`;
    const maxPlays = entries[0][1].plays;
    html += entries.slice(0, 30).map(([vid, v], i) => `
      <div class="stat-bar-row" data-item='${esc(JSON.stringify({ videoId: vid, title: v.title, artist: v.artist, thumbnail: v.thumbnail }))}'>
        <span class="sb-rank">${i + 1}</span>
        <span class="sb-name">${esc(v.title)}</span>
        <span class="sb-bar"><div style="width:${Math.round((v.plays / maxPlays) * 100)}%"></div></span>
        <span class="sb-n">${v.plays}</span>
      </div>`).join('');
  }
  el.innerHTML = html;
  $$('.stat-bar-row', el).forEach((r) => {
    r.style.cursor = 'pointer';
    r.addEventListener('click', () => {
      let it;
      try { it = JSON.parse(r.dataset.item); } catch { return; }
      if (it.videoId) playSong(songFromItem(it));
    });
  });
}

/* ---- browse page (album / artist / playlist / mood) ---- */
async function renderBrowsePage(el, id, params) {
  el.innerHTML = '<div class="loading-note">Loading…</div>';
  try {
    const d = await api(`/api/browse?id=${encodeURIComponent(id)}${params ? '&params=' + encodeURIComponent(params) : ''}`);
    let html = '';
    // header
    if (d.header) {
      const h = d.header;
      const isArtist = id.startsWith('UC') || id.startsWith('MPLA');
      html += `<div class="detail-head${isArtist ? ' artist' : ''}">`;
      if (h.thumbnail) {
        html += `<img src="${esc(h.thumbnail)}" alt="">`;
      } else {
        html += `<div class="detail-ph">${icon(isArtist ? 'i-radio' : 'i-note')}</div>`;
      }
      html += `<div class="detail-info">
        <div class="detail-kicker">${esc(h.strapline || id.startsWith('MPRE') ? 'Album' : isArtist ? 'Artist' : 'Playlist')}</div>
        <h1>${esc(h.title)}</h1>
        ${h.description ? `<div class="sub" style="max-width:600px">${esc(h.description)}</div>` : ''}
        <div class="sub">${esc(h.subtitle || '')}</div>
        <div class="detail-actions">`;
      if (d.tracks && d.tracks.length) {
        html += `<button class="pill-btn primary" data-act="play-all">${icon('i-play')}<span>Play</span></button>`;
        html += `<button class="pill-btn" data-act="shuffle-all">${icon('i-shuffle')}<span>Shuffle</span></button>`;
      }
      if (d.playlistId) {
        html += `<button class="pill-btn" data-act="save-browse" data-bid="${esc(id)}">${icon(Library.isSaved(id) ? 'i-save-f' : 'i-save')}<span>${Library.isSaved(id) ? 'Saved' : 'Save'}</span></button>`;
      }
      html += `</div></div></div>`;
    }
    // tracks
    if (d.tracks && d.tracks.length) {
      html += trackHeadHTML();
      html += `<div class="track-list">${d.tracks.map((t, i) => trackRowHTML({ ...t, tn: i + 1, plId: 'browse', plIndex: i })).join('')}</div>`;
    }
    // other sections
    for (const sec of d.sections || []) {
      html += shelfHTML(sec);
    }
    el.innerHTML = html;
    // bind
    const tracks = d.tracks || [];
    bindTrackList(el, tracks, 'browse');
    const playAll = $('[data-act="play-all"]', el);
    if (playAll) playAll.addEventListener('click', () => {
      if (!tracks.length) return;
      playSong(songFromItem(tracks[0]), tracks.map(songFromItem), 0);
    });
    const shuffleAll = $('[data-act="shuffle-all"]', el);
    if (shuffleAll) shuffleAll.addEventListener('click', () => {
      if (!tracks.length) return;
      Player.shuffle = true;
      playSong(songFromItem(tracks[Math.floor(Math.random() * tracks.length)]), tracks.map(songFromItem));
    });
    const saveBtn = $('[data-act="save-browse"]', el);
    if (saveBtn) saveBtn.addEventListener('click', () => {
      if (!d.header) return;
      Library.toggleSaved({ browseId: id, title: d.header.title, subtitle: d.header.subtitle, thumbnail: d.header.thumbnail, type: id.startsWith('MPRE') ? 'album' : id.startsWith('UC') ? 'artist' : 'playlist' });
      saveBtn.innerHTML = icon(Library.isSaved(id) ? 'i-save-f' : 'i-save') + `<span>${Library.isSaved(id) ? 'Saved' : 'Save'}</span>`;
    });
    bindItems(el);
    // tint from header
    if (d.header && d.header.title) applyTint(d.header.title);
  } catch (e) {
    el.innerHTML = emptyHTML('Failed to load', e.message, { label: 'Retry', act: 'reload-browse' });
    bindItems(el);
  }
}

/* ---- local playlist page ---- */
function renderLocalPlaylistPage(el, pid) {
  const pls = Library.playlists;
  const pl = pls.find((p) => p.id === pid);
  if (!pl) { el.innerHTML = emptyHTML('Playlist not found', 'It may have been deleted.', { label: 'Go to Library', go: '#/library' }); bindItems(el); return; }
  let html = `<div class="detail-head">
    <div class="detail-ph">${icon('i-note')}</div>
    <div class="detail-info">
      <div class="detail-kicker">Playlist</div>
      <h1 contenteditable="true" id="pl-edit-name" spellcheck="false">${esc(pl.name)}</h1>
      <div class="sub">${pl.tracks.length} songs</div>
      <div class="detail-actions">
        ${pl.tracks.length ? `<button class="pill-btn primary" data-act="play-pl">${icon('i-play')}<span>Play</span></button>` : ''}
        ${pl.tracks.length ? `<button class="pill-btn" data-act="shuffle-pl">${icon('i-shuffle')}<span>Shuffle</span></button>` : ''}
        <button class="pill-btn" data-act="rename-pl">${icon('i-save')}<span>Rename</span></button>
        <button class="pill-btn" data-act="delete-pl">${icon('i-trash')}<span>Delete</span></button>
      </div>
    </div>
  </div>`;
  if (pl.tracks.length) {
    html += trackHeadHTML();
    html += `<div class="track-list">${pl.tracks.map((t, i) => trackRowHTML({ ...t, tn: i + 1, plId: pid, plIndex: i })).join('')}</div>`;
  } else {
    html += '<div class="empty-note">No songs yet. Add songs from any page.</div>';
  }
  el.innerHTML = html;
  bindTrackList(el, pl.tracks, pid);
  const playBtn = $('[data-act="play-pl"]', el);
  if (playBtn) playBtn.addEventListener('click', () => playSong(songFromItem(pl.tracks[0]), pl.tracks.map(songFromItem), 0));
  const shuffleBtn = $('[data-act="shuffle-pl"]', el);
  if (shuffleBtn) shuffleBtn.addEventListener('click', () => { Player.shuffle = true; playSong(songFromItem(pl.tracks[Math.floor(Math.random() * pl.tracks.length)]), pl.tracks.map(songFromItem)); });
  const renameBtn = $('[data-act="rename-pl"]', el);
  if (renameBtn) renameBtn.addEventListener('click', () => {
    const nameEl = $('#pl-edit-name');
    if (!nameEl) return;
    nameEl.focus();
    const range = document.createRange();
    range.selectNodeContents(nameEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });
  const nameEl = $('#pl-edit-name');
  if (nameEl) {
    nameEl.addEventListener('blur', () => {
      const n = nameEl.textContent.trim();
      if (n && n !== pl.name) { Library.renamePlaylist(pid, n); toast('Playlist renamed'); }
    });
    nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); } });
  }
  const deleteBtn = $('[data-act="delete-pl"]', el);
  if (deleteBtn) deleteBtn.addEventListener('click', () => {
    if (confirm('Delete this playlist?')) { Library.deletePlaylist(pid); router.go('#/library'); toast('Playlist deleted'); }
  });
}

/* ---- bind track list (favorites, browse, playlist) ---- */
function bindTrackList(el, tracks, plId) {
  $$('.track', el).forEach((row) => {
    let it;
    try { it = JSON.parse(row.dataset.item); } catch { return; }
    row.addEventListener('click', (e) => {
      if (e.target.closest('.tbtn')) return;
      const song = songFromItem(it);
      const pl = plId === 'fav' ? Library.favorites.map(songFromItem) : plId === 'browse' ? tracks.map(songFromItem) : null;
      const idx = it.plIndex != null ? it.plIndex : 0;
      playSong(song, pl, idx);
    });
    const favBtn = $('.btn-fav', row);
    if (favBtn) favBtn.addEventListener('click', (e) => { e.stopPropagation(); const s = songFromItem(it); Library.toggleFav(s); favBtn.innerHTML = icon(Library.isFav(s.videoId) ? 'i-heart-f' : 'i-heart-o'); });
    const addBtn = $('.btn-addpl', row);
    if (addBtn) addBtn.addEventListener('click', (e) => { e.stopPropagation(); openAddToPlaylist(songFromItem(it)); });
    const qBtn = $('.btn-queue', row);
    if (qBtn) qBtn.addEventListener('click', (e) => { e.stopPropagation(); queueSong(songFromItem(it)); });
    const dlBtn = $('.btn-dl', row);
    if (dlBtn) dlBtn.addEventListener('click', (e) => { e.stopPropagation(); downloadSong(songFromItem(it)); });
    const moreBtn = $('.btn-more', row);
    if (moreBtn) moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const s = songFromItem(it);
      const opts = {};
      if (plId && plId !== 'fav' && plId !== 'browse') {
        opts.plId = plId;
        opts.plIndex = it.plIndex;
      }
      openSongMenu(s, opts);
    });
  });
  // drag reorder for local playlists
  if (plId && plId !== 'fav' && plId !== 'browse') {
    $$('.track.pl-track', el).forEach((row) => {
      row.draggable = true;
      row.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', String(it.plIndex));
        e.dataTransfer.effectAllowed = 'move';
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
      row.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; row.classList.add('drag-over'); });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('drag-over');
        const from = Number(e.dataTransfer.getData('text/plain'));
        const to = it.plIndex;
        if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return;
        if (Library.moveInPlaylist(plId, from, to - from > 0 ? 1 : -1)) {
          renderLocalPlaylistPage(el, plId);
          renderSidebarLibrary();
        }
      });
    });
  }
}

/* ================= modals ================= */
function openModal(title, bodyHTML, opts = {}) {
  const modal = $('#modal');
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHTML;
  modal.classList.remove('hidden');
  // close
  const close = () => modal.classList.add('hidden');
  $('#modal-cancel').onclick = close;
  modal.onclick = (e) => { if (e.target === modal) close(); };
  if (opts.onClose) {
    const origClose = close;
    // not needed but for clarity
  }
  return { close, el: $('#modal-body') };
}
function openAddToPlaylist(song) {
  const pls = Library.playlists;
  let html = `<div class="sm-head">
    <img src="${esc(song.thumbnail || '')}" alt="">
    <div class="sm-meta"><div class="sm-t">${esc(song.title)}</div><div class="sm-s">${esc(song.artist || '')}</div></div>
  </div>`;
  if (pls.length) {
    html += `<div class="pl-list-label">Your playlists</div>`;
    for (const p of pls) {
      const has = p.tracks.some((t) => t.videoId === song.videoId);
      const thumb = p.tracks[0] && p.tracks[0].thumbnail ? p.tracks[0].thumbnail : '';
      html += `<button class="modal-row pl-pick" data-pid="${p.id}"${has ? ' disabled' : ''}>
        <img class="pl-pick-art" src="${esc(thumb)}" alt="">
        <div class="pl-pick-meta"><span class="pl-pick-name">${esc(p.name)}</span><span class="pl-pick-count">${p.tracks.length} songs${has ? ' · already added' : ''}</span></div>
      </button>`;
    }
  } else {
    html += `<div class="empty-note" style="padding:16px 0">No playlists yet.</div>`;
  }
  html += `<div style="margin-top:14px"><button class="pill-btn" data-act="new-pl-from-modal">${icon('i-plus')}<span>New Playlist</span></button></div>`;
  const { close, el: body } = openModal('Add to playlist', html);
  $$('.pl-pick:not([disabled])', body).forEach((b) => b.addEventListener('click', () => {
    Library.addToPlaylist(b.dataset.pid, song);
    toast('Added to playlist');
    close();
    renderSidebarLibrary();
  }));
  const newBtn = $('[data-act="new-pl-from-modal"]', body);
  if (newBtn) newBtn.addEventListener('click', () => { close(); openCreatePlaylist(song); });
}
function openCreatePlaylist(addSong = null) {
  let html = `<div class="pl-form">
    <div class="pl-form-cover">${icon('i-plus')}</div>
    <div class="pl-form-label">Name</div>
    <input type="text" class="pl-form-input" id="new-pl-name" placeholder="My playlist" maxlength="80" autofocus />
    <div class="pl-form-hint">Create a new playlist to organize your music.</div>
    <div class="pl-form-actions">
      <button class="pill-btn" id="pl-cancel-btn">Cancel</button>
      <button class="pill-btn primary" id="pl-create-btn">Create</button>
    </div>
  </div>`;
  const { close, el: body } = openModal('Create Playlist', html);
  const input = $('#new-pl-name', body);
  const cancelBtn = $('#pl-cancel-btn', body);
  const createBtn = $('#pl-create-btn', body);
  cancelBtn.addEventListener('click', close);
  const doCreate = () => {
    const name = input.value.trim();
    if (!name) { input.classList.add('shake'); setTimeout(() => input.classList.remove('shake'), 400); return; }
    const pl = Library.createPlaylist(name);
    if (addSong && addSong.videoId) { Library.addToPlaylist(pl.id, addSong); toast('Playlist created and song added'); }
    else { toast('Playlist created'); }
    close();
    renderSidebarLibrary();
  };
  createBtn.addEventListener('click', doCreate);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doCreate(); });
  setTimeout(() => input.focus(), 100);
}
function openSongMenu(song, opts = {}) {
  const abid = songArtistBrowseId(song);
  let html = `<div class="sm-head">
    <img src="${esc(song.thumbnail || '')}" alt="">
    <div class="sm-meta"><div class="sm-t">${esc(song.title)}</div><div class="sm-s">${esc(song.artist || '')}</div></div>
  </div>`;
  html += `<button class="modal-row" data-act="menu-fav">${icon(Library.isFav(song.videoId) ? 'i-heart-f' : 'i-heart-o')}<span>${Library.isFav(song.videoId) ? 'Remove from favorites' : 'Add to favorites'}</span></button>`;
  html += `<button class="modal-row" data-act="menu-queue">${icon('i-queue')}<span>Add to queue</span></button>`;
  html += `<button class="modal-row" data-act="menu-playnext">${icon('i-next')}<span>Play next</span></button>`;
  html += `<button class="modal-row" data-act="menu-addpl">${icon('i-plus')}<span>Add to playlist</span></button>`;
  html += `<button class="modal-row" data-act="menu-dl">${icon('i-download')}<span>Download (320kbps MP3)</span></button>`;
  if (abid) html += `<button class="modal-row" data-act="menu-artist">${icon('i-radio')}<span>Go to artist</span></button>`;
  if (opts.qi != null) html += `<button class="modal-row" data-act="menu-remove-q" style="color:var(--accent-bright)">${icon('i-x')}<span>Remove from queue</span></button>`;
  if (opts.plId && opts.plId !== 'fav' && opts.plId !== 'browse' && opts.plIndex != null) {
    html += `<button class="modal-row" data-act="menu-remove-pl" style="color:var(--accent-bright)">${icon('i-trash')}<span>Remove from playlist</span></button>`;
  }
  const { close, el: body } = openModal('More options', html);
  const act = (a) => {
    switch (a) {
      case 'menu-fav': Library.toggleFav(song); break;
      case 'menu-queue': queueSong(song); break;
      case 'menu-playnext': queueSong(song, true); break;
      case 'menu-addpl': close(); openAddToPlaylist(song); return;
      case 'menu-dl': close(); downloadSong(song); return;
      case 'menu-artist': close(); router.go(`#/browse/${abid}`); return;
      case 'menu-remove-q': removeQueued(opts.qi); break;
      case 'menu-remove-pl': Library.removeFromPlaylist(opts.plId, song.videoId); renderSidebarLibrary(); toast('Removed from playlist'); break;
    }
    close();
  };
  $$('.modal-row', body).forEach((b) => b.addEventListener('click', () => act(b.dataset.act)));
}

/* ================= now playing tabs ================= */
function switchNPTab(tab) {
  $$('.np-tab').forEach((t) => t.classList.toggle('active', t.dataset.nptab === tab));
  $$('.np-pane').forEach((p) => p.classList.toggle('active', p.id === 'np-' + tab));
  if (tab === 'queue') renderQueue();
  if (tab === 'related') loadRelated();
  if (tab === 'lyrics') {
    const c = $('#lyrics-container');
    const active = c.querySelector('.lyric-line.active');
    if (active) setTimeout(() => active.scrollIntoView({ block: 'center', behavior: 'smooth' }), 100);
  }
}
function syncNpMore() {
  const btn = $('#np-more');
  if (!btn) return;
  const on = [Player.sbEnabled, Player.hq].some(Boolean);
  btn.classList.toggle('has-on', on);
}

/* ================= seek bar ================= */
let seekDragging = false;
function initSeekBars() {
  // mini player seek
  const bar = $('#mini-bar');
  if (bar) {
    const seek = (e) => {
      if (!Player.yt || !Player.ready || !Player.yt.getDuration) return;
      const r = bar.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      Player.yt.seekTo(pct * Player.yt.getDuration(), true);
    };
    bar.addEventListener('click', seek);
    bar.addEventListener('mousedown', () => { seekDragging = true; });
  }
  // np range
  const npRange = $('#np-range');
  if (npRange) {
    npRange.addEventListener('input', () => {
      if (!Player.yt || !Player.ready || !Player.yt.getDuration) return;
      const pct = Number(npRange.value) / 1000;
      Player.yt.seekTo(pct * Player.yt.getDuration(), true);
    });
    npRange.addEventListener('mousedown', () => { seekDragging = true; });
    npRange.addEventListener('touchstart', () => { seekDragging = true; }, { passive: true });
  }
  document.addEventListener('mouseup', () => { seekDragging = false; });
  document.addEventListener('touchend', () => { seekDragging = false; });
}

/* ================= volume ================= */
function initVolume() {
  const miniVol = $('#mini-volume');
  const npVol = $('#np-volume');
  const setVol = (v) => {
    v = Math.max(0, Math.min(100, Number(v)));
    if (Player.yt && Player.ready) Player.yt.setVolume(v);
    store.set('vol', v);
    if (miniVol) miniVol.value = v;
    if (npVol) npVol.value = v;
  };
  if (miniVol) miniVol.addEventListener('input', () => setVol(miniVol.value));
  if (npVol) npVol.addEventListener('input', () => setVol(npVol.value));
  setVol(store.get('vol', 100));
}

/* ================= floating widget ================= */
Player.floatOn = false;
function toggleFloat() {
  if (Player.floatOn) { closeFloat(); return; }
  if (!Player.current) return;
  Player.floatOn = true;
  $('#float-widget').classList.remove('hidden');
  $('#float-widget').style.left = '16px';
  $('#float-widget').style.top = 'calc(100vh - var(--player-h) - 120px)';
  document.body.classList.add('float-mode');
  syncFloatWidget();
  $('#mini-float').classList.add('on');
  $('#np-float').classList.add('on');
  toast('Floating widget on');
}
function closeFloat() {
  Player.floatOn = false;
  $('#float-widget').classList.add('hidden');
  document.body.classList.remove('float-mode');
  $('#mini-float').classList.remove('on');
  $('#np-float').classList.remove('on');
}
function syncFloatWidget() {
  if (!Player.floatOn) return;
  const s = Player.current;
  if (!s) return;
  $('#fw-art').src = safeCover(s.thumbnail) || COVER_PH;
  $('#fw-title').textContent = displayTitle(s.title) || s.title || '';
  $('#fw-artist').textContent = s.artist || s.subtitle || '';
  const actuallyPlaying = Player.yt && Player.ready && Player.yt.getPlayerState && Player.yt.getPlayerState() === YT.PlayerState.PLAYING;
  const preview = isPreviewing();
  const fwPlayBtn = $('.fw-play', $('#float-widget'));
  if (fwPlayBtn) fwPlayBtn.innerHTML = icon(!preview && actuallyPlaying ? 'i-pause' : 'i-play');
}
function syncFloatProgress(pct) {
  if (!Player.floatOn) return;
  $('#fw-fill').style.width = pct + '%';
}
function syncFloatLyric(line) {
  if (!Player.floatOn) return;
  $('#fw-lyric').textContent = line;
}
function initFloatWidget() {
  // drag
  const fw = $('#float-widget');
  if (!fw) return;
  let dragging = false, startX, startY, origX, origY;
  const onStart = (e) => {
    if (e.target.closest('.fw-btn')) return;
    dragging = true;
    fw.classList.add('dragging');
    const t = e.touches ? e.touches[0] : e;
    startX = t.clientX; startY = t.clientY;
    const rect = fw.getBoundingClientRect();
    origX = rect.left; origY = rect.top;
    e.preventDefault();
  };
  const onMove = (e) => {
    if (!dragging) return;
    const t = e.touches ? e.touches[0] : e;
    let x = origX + t.clientX - startX;
    let y = origY + t.clientY - startY;
    x = Math.max(0, Math.min(window.innerWidth - fw.offsetWidth, x));
    y = Math.max(0, Math.min(window.innerHeight - fw.offsetHeight, y));
    fw.style.left = x + 'px';
    fw.style.top = y + 'px';
  };
  const onEnd = () => { dragging = false; fw.classList.remove('dragging'); };
  fw.addEventListener('mousedown', onStart);
  fw.addEventListener('touchstart', onStart, { passive: false });
  document.addEventListener('mousemove', onMove);
  document.addEventListener('touchmove', onMove, { passive: false });
  document.addEventListener('mouseup', onEnd);
  document.addEventListener('touchend', onEnd);
  // buttons
  $$('.fw-btn', fw).forEach((b) => b.addEventListener('click', () => {
    const act = b.dataset.fw;
    if (act === 'prev') prevTrack();
    else if (act === 'play') toggleNowPlayingPlay();
    else if (act === 'next') nextTrack(false);
    else if (act === 'close') closeFloat();
  }));
  // click lyric to open lyrics
  const fwLyric = $('#fw-lyric');
  if (fwLyric) fwLyric.addEventListener('click', () => { openNowPlaying(); switchNPTab('lyrics'); });
  // click bar to seek
  const fwBar = $('#fw-bar');
  if (fwBar) fwBar.addEventListener('click', (e) => {
    if (!Player.yt || !Player.ready || !Player.yt.getDuration) return;
    const r = fwBar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    Player.yt.seekTo(pct * Player.yt.getDuration(), true);
  });
}

/* ================= PiP (OS Picture-in-Picture) ================= */
let pipCanvasCtx = null;
function drawPipFrame(pct) {
  const canvas = $('#pip-canvas');
  const video = $('#pip-video');
  if (!canvas || !video) return;
  if (!pipCanvasCtx) pipCanvasCtx = canvas.getContext('2d');
  const ctx = pipCanvasCtx;
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  // draw cover
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = `/api/thumb?url=${encodeURIComponent(Player.current.thumbnail || '')}`;
  img.onload = () => { ctx.drawImage(img, 0, 0, w, h); };
  // draw progress bar
  ctx.fillStyle = '#1ed760';
  ctx.fillRect(0, h - 4, w * (pct / 100), 4);
  // draw title
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(0, h - 40, w, 36);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 11px Figtree, sans-serif';
  const title = displayTitle(Player.current.title || '') || '';
  ctx.fillText(title.slice(0, 30), 6, h - 18);
  // stream to video
  try {
    const stream = canvas.captureStream(1);
    video.srcObject = stream;
    if (video.paused) video.play().catch(() => {});
  } catch {}
}

/* ================= sleep timer ================= */
function toggleSleepTimer() {
  if (Player.sleepTimer) {
    clearTimeout(Player.sleepTimer);
    Player.sleepTimer = null;
    $('#np-sleep').classList.remove('on');
    toast('Sleep timer cancelled');
    return;
  }
  const mins = [15, 30, 45, 60];
  const choice = mins[Math.floor(Math.random() * mins.length)];
  Player.sleepTimer = setTimeout(() => {
    if (Player.yt && Player.ready) Player.yt.pauseVideo();
    Player.sleepTimer = null;
    $('#np-sleep').classList.remove('on');
    toast('Sleep timer: paused playback');
  }, choice * 60 * 1000);
  $('#np-sleep').classList.add('on');
  toast(`Sleep timer: ${choice} minutes`);
}

/* ================= init ================= */
function init() {
  renderNav();
  renderSidebarLibrary();
  initSeekBars();
  initVolume();
  initFloatWidget();
  updateThemeIcon();

  // now playing tab clicks
  $$('.np-tab').forEach((t) => t.addEventListener('click', () => switchNPTab(t.dataset.nptab)));

  // mini player clicks
  $('#mini-art') && $('#mini-art').addEventListener('click', () => { openNowPlaying(); switchNPTab('player'); });
  $('#mini-meta') && $('#mini-meta').addEventListener('click', () => { openNowPlaying(); switchNPTab('player'); });
  const miniArtist = $('#mini-artist');
  if (miniArtist) miniArtist.addEventListener('click', () => {
    const abid = songArtistBrowseId(Player.current);
    if (abid) { closeNowPlaying(); router.go(`#/browse/${abid}`); }
  });
  $('#mini-like').addEventListener('click', () => { if (Player.current) Library.toggleFav(Player.current); });
  $('#mini-play').addEventListener('click', toggleNowPlayingPlay);
  $('#mini-prev').addEventListener('click', prevTrack);
  $('#mini-next').addEventListener('click', () => nextTrack(false));
  $('#mini-shuffle').addEventListener('click', () => {
    Player.shuffle = !Player.shuffle;
    $('#mini-shuffle').classList.toggle('on', Player.shuffle);
    $('#np-shuffle').classList.toggle('on', Player.shuffle);
    persistQueue();
    toast(Player.shuffle ? 'Shuffle on' : 'Shuffle off');
  });
  $('#mini-repeat').addEventListener('click', () => {
    Player.repeat = (Player.repeat + 1) % 3;
    const on = Player.repeat > 0;
    const ic = icon(Player.repeat === 2 ? 'i-repeat-1' : 'i-repeat');
    [$('#mini-repeat'), $('#np-repeat')].forEach((b) => {
      if (!b) return;
      b.classList.toggle('on', on);
      b.innerHTML = ic;
    });
    persistQueue();
    toast(['Repeat off', 'Repeat all', 'Repeat one'][Player.repeat]);
  });
  $('#mini-queue').addEventListener('click', () => { openNowPlaying(); switchNPTab('queue'); });
  $('#mini-queue-m').addEventListener('click', () => { openNowPlaying(); switchNPTab('queue'); });
  $('#mini-open').addEventListener('click', () => { openNowPlaying(); switchNPTab('player'); });
  $('#mini-float').addEventListener('click', toggleFloat);

  // now playing clicks
  $('#np-close').addEventListener('click', closeNowPlaying);
  $('#np-play').addEventListener('click', toggleNowPlayingPlay);
  $('#np-prev').addEventListener('click', prevTrack);
  $('#np-next').addEventListener('click', () => nextTrack(false));
  $('#np-shuffle').addEventListener('click', () => {
    Player.shuffle = !Player.shuffle;
    $('#mini-shuffle').classList.toggle('on', Player.shuffle);
    $('#np-shuffle').classList.toggle('on', Player.shuffle);
    persistQueue();
    toast(Player.shuffle ? 'Shuffle on' : 'Shuffle off');
  });
  $('#np-repeat').addEventListener('click', () => {
    Player.repeat = (Player.repeat + 1) % 3;
    const on = Player.repeat > 0;
    const ic = icon(Player.repeat === 2 ? 'i-repeat-1' : 'i-repeat');
    [$('#mini-repeat'), $('#np-repeat')].forEach((b) => {
      if (!b) return;
      b.classList.toggle('on', on);
      b.innerHTML = ic;
    });
    persistQueue();
    toast(['Repeat off', 'Repeat all', 'Repeat one'][Player.repeat]);
  });
  $('#np-like').addEventListener('click', () => { const s = focusedSong(); if (s) Library.toggleFav(s); });
  $('#np-addpl').addEventListener('click', () => { const s = focusedSong(); if (s) openAddToPlaylist(s); });
  $('#np-playnext').addEventListener('click', () => { const s = Player.pending; if (s) { queueSong(s, true); Player.pending = null; renderNowPlaying(); renderPlayButtons(); } });
  $('#np-queueadd').addEventListener('click', () => { const s = Player.pending; if (s) { queueSong(s); Player.pending = null; renderNowPlaying(); renderPlayButtons(); } });
  $('#np-more').addEventListener('click', () => {
    const s = focusedSong();
    if (s) openSongMenu(s);
  });
  $('#np-download').addEventListener('click', () => { const s = focusedSong(); if (s) downloadSong(s); });
  $('#np-share').addEventListener('click', () => {
    const s = focusedSong();
    if (!s || !s.videoId) return;
    const url = `https://music.youtube.com/watch?v=${s.videoId}`;
    navigator.clipboard.writeText(url).then(() => toast('Link copied')).catch(() => toast('Failed to copy'));
  });
  $('#np-speed').addEventListener('click', cycleSpeed);
  $('#np-float').addEventListener('click', toggleFloat);
  $('#np-quality').addEventListener('click', toggleQuality);
  $('#np-sb').addEventListener('click', toggleSB);
  $('#np-sleep').addEventListener('click', toggleSleepTimer);
  $('#np-lyric-preview').addEventListener('click', () => { switchNPTab('lyrics'); });
  // artist click in NP
  const npArtist = $('#np-artist');
  if (npArtist) npArtist.addEventListener('click', () => {
    const s = focusedSong();
    if (!s) return;
    const abid = songArtistBrowseId(s);
    if (abid) { closeNowPlaying(); router.go(`#/browse/${abid}`); }
  });

  // sidebar
  $('#side-queue-btn').addEventListener('click', () => { openNowPlaying(); switchNPTab('queue'); });
  $('#side-q-clear').addEventListener('click', clearUserQueue);
  $('#lib-title-btn').addEventListener('click', () => router.go('#/library'));
  $('#lib-new').addEventListener('click', openCreatePlaylist);

  // topbar
  $('#tb-search').addEventListener('click', () => router.go('#/search'));
  $('#theme-toggle').addEventListener('click', toggleTheme);
  $('#nav-back').addEventListener('click', () => router.back());
  $('#nav-fwd').addEventListener('click', () => router.fwd());

  // global action handlers (delegated from empty-cta etc.)
  document.addEventListener('click', (e) => {
    const cta = e.target.closest('[data-act]');
    if (!cta) return;
    const act = cta.dataset.act;
    if (act === 'reload-home') renderHome($('#view'));
    else if (act === 'reload-browse') router._render();
    else if (act === 'create-pl') openCreatePlaylist();
    else if (act === 'stats') router.go('#/library/stats');
  });

  // keyboard
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    if (e.code === 'ArrowRight' && e.ctrlKey) { e.preventDefault(); nextTrack(false); }
    if (e.code === 'ArrowLeft' && e.ctrlKey) { e.preventDefault(); prevTrack(); }
  });

  // restore state
  restoreQueue();
  router._onHash();

  // splash
  setTimeout(() => {
    const splash = $('#splash');
    if (splash) splash.classList.add('gone');
  }, 1200);
}

document.addEventListener('DOMContentLoaded', init);