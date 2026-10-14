(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var cockpit = $('cockpit');
  var menu = $('settingsMenu');
  var hint = $('settingsHint');
  var closeSettings = $('closeSettings');

  var STORAGE_KEY = 'speedoHudLayout';
  var SPEED_LIMIT_MPH = 60; // Batas kecepatan visual overspeed tepat 60 MPH (~97 KM/H)
  var RPM_SEGMENTS_COUNT = 19; // 19 garis strip horizontal bertumpuk vertikal
  var THEMES = ['theme-syahram', 'theme-obsidian', 'theme-titanium'];
  var THEME_NAMES = ['Syahram Matte Grey', 'Stealth Obsidian Dark', 'Warm Titanium Slate'];

  /* ================= DAFTAR 9 STASIUN RADIO FM LIVE STREAMING ================= */
  const stations = [
    { name: "Delta FM", url: "https://s1.cloudmu.id/listen/delta_fm/radio.mp3" },
    { name: "Prambors FM", url: "https://s2.cloudmu.id/listen/prambors/radio.aac" },
    { name: "I Radio", url: "https://stream.radiojar.com/4ywdgup3bnzuv" },
    { name: "Female Radio", url: "https://s1.cloudmu.id/listen/female_radio/radio.mp3" },
    { name: "KPOP Radio", url: "https://stream9.mexiserver.com:7122/stream" },
    { name: "Kiss FM", url: "https://live.kissfmmedan.com/kissfm.mp3" },
    { name: "JGRP Radio", url: "https://s7.alhastream.com/radio/8350/live" },
    { name: "Hits Radio", url: "https://playerservices.streamtheworld.com/api/livestream-redirect/977_HITS_SC" },
    { name: "Hits Love", url: "https://radio2.vip-radios.fm:18012/stream-128kmp3-HitsLove" }
  ];

  /* ================= STATE & FALLBACK TARGETS ================= */
  var S = {
    engine: false,
    speed: 0,
    speedMS: 0,
    speedMode: 0, // 0: km/h, 1: mph, 2: knots
    rpm: 0,
    fuel: 0,
    health: 0,
    gear: 'N',
    lights: 0,
    left: false,
    right: false,
    belt: false,
    locked: false,
    odo: 0
  };

  var L = { tx: 0, ty: 0, scale: 1, theme: 0 };
  var mode = null;
  var prevEngineState = false;
  var prevHealthVal = 100;
  var prevLockedState = null;
  var bootSweepActive = false;
  var bootSweepTimer = null;
  var impactTimer = null;
  var lockSnapTimer = null;
  var rpmSegments = [];

  var elements = {
    engine: $('engine'),
    speed: $('speed'),
    rpm: $('rpm'),
    fuel: $('fuel'),
    health: $('health'),
    gear: $('gear'),
    headlights: $('headlights'),
    indicators: $('indicators'),
    seatbelts: $('seatbelts'),
    odometer: $('odometer')
  };

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function num(v, d) { v = Number(v); return isNaN(v) ? (d || 0) : v; }
  var onOrOff = function (s) { return s ? 'On' : 'Off'; };

  function setText(id, value) {
    var el = $(id);
    if (el) el.textContent = String(value);
  }

  /* ================= MEMBANGUN 19 STRIP RPM VERTIKAL ================= */
  function buildRPMLadder() {
    var ladder = $('rpmLadder');
    if (!ladder) return;
    ladder.innerHTML = '';
    rpmSegments = [];
    for (var i = 0; i < RPM_SEGMENTS_COUNT; i++) {
      var seg = document.createElement('span');
      seg.className = 'rpm-seg';
      ladder.appendChild(seg);
      rpmSegments.push(seg);
    }
  }

  function paintRPMSegments(activeCount) {
    for (var i = 0; i < rpmSegments.length; i++) {
      var seg = rpmSegments[i];
      seg.className = 'rpm-seg';
      if (i < activeCount) {
        var ratio = (i + 1) / rpmSegments.length;
        if (ratio > 0.85) {
          seg.classList.add('on-high');
        } else if (ratio > 0.62) {
          seg.classList.add('on-mid');
        } else {
          seg.classList.add('on-low');
        }
      }
    }
  }

  function runBootSweep() {
    if (bootSweepTimer) clearInterval(bootSweepTimer);
    bootSweepActive = true;
    var step = 0;
    var totalSteps = RPM_SEGMENTS_COUNT * 2;
    bootSweepTimer = setInterval(function () {
      step++;
      var count = step <= RPM_SEGMENTS_COUNT ? step : (totalSteps - step);
      paintRPMSegments(clamp(count, 0, RPM_SEGMENTS_COUNT));
      if (step >= totalSteps) {
        clearInterval(bootSweepTimer);
        bootSweepTimer = null;
        bootSweepActive = false;
        renderRPM();
      }
    }, 18);
  }

  /* ================= SUARA SEATBELT CHIME LEMBUT (587Hz & 880Hz) ================= */
  var audioCtx = null;
  var beltBeepTimer = null;

  function getAudioContext() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    return audioCtx;
  }

  function playBeltChime() {
    if (S.belt || !S.engine) return;
    try {
      var ctx = getAudioContext();
      var now = ctx.currentTime;
      var notes = [
        { freq: 587, delay: 0.0, dur: 0.22 },
        { freq: 880, delay: 0.18, dur: 0.32 }
      ];

      notes.forEach(function (n) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(n.freq, now + n.delay);

        gain.gain.setValueAtTime(0.0001, now + n.delay);
        gain.gain.linearRampToValueAtTime(0.045, now + n.delay + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + n.delay + n.dur);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now + n.delay);
        osc.stop(now + n.delay + n.dur + 0.02);
      });
    } catch (e) {}
  }

  function updateBeltBeep() {
    if (!S.belt && S.engine) {
      if (!beltBeepTimer) {
        playBeltChime();
        beltBeepTimer = setInterval(playBeltChime, 2600);
      }
    } else {
      if (beltBeepTimer) {
        clearInterval(beltBeepTimer);
        beltBeepTimer = null;
      }
    }
  }

  /* ================= SINKRONISASI AUDIO, MINI PILL, & ANTI-BENTROK ================= */
  var radioAudio = new Audio();
  radioAudio.preload = 'none';
  radioAudio.crossOrigin = 'anonymous';
  var currentStationIndex = 0;
  var isRadioPlaying = false;

  var MUSIC_STORAGE_KEY = 'samc_music_playlist_v1';
  var musicPlayer = null;
  var musicApiReady = false;
  var musicReady = false;
  var musicPlaylist = [];
  var musicIndex = -1;
  var musicRepeat = false;
  var musicShuffle = false;
  var musicProgressTimer = null;
  var musicPendingLoad = null;

  // State untuk Floating Mini Audio Pill (#mini-music-pill)
  var activeAudioSource = 'radio'; // 'radio' | 'youtube'
  var hasAudioActivated = false;
  var miniPillDismissed = false;

  function isYouTubePlaying() {
    if (!musicPlayer || !musicReady || typeof musicPlayer.getPlayerState !== 'function') return false;
    return musicPlayer.getPlayerState() === 1;
  }

  function updateMiniPill() {
    var pill = $('mini-music-pill');
    if (!pill) return;

    var ytPlaying = isYouTubePlaying();
    var anyPlaying = isRadioPlaying || ytPlaying;

    if (isRadioPlaying) {
      activeAudioSource = 'radio';
      hasAudioActivated = true;
      miniPillDismissed = false;
    } else if (ytPlaying) {
      activeAudioSource = 'youtube';
      hasAudioActivated = true;
      miniPillDismissed = false;
    }

    var shouldShow = hasAudioActivated && !miniPillDismissed;
    pill.classList.toggle('show', shouldShow);
    pill.classList.toggle('playing', anyPlaying);

    var badge = $('miniSourceBadge');
    if (badge) {
      if (activeAudioSource === 'youtube') {
        badge.textContent = '▶ YT';
        badge.className = 'mini-source-badge yt-mode';
      } else {
        badge.textContent = '📻 RADIO';
        badge.className = 'mini-source-badge radio-mode';
      }
    }

    var titleEl = $('miniTrackTitle');
    if (titleEl) {
      if (activeAudioSource === 'youtube') {
        var track = musicPlaylist[musicIndex];
        titleEl.textContent = track ? track.title : 'YouTube Track';
      } else {
        var st = stations[currentStationIndex] || stations[0];
        titleEl.textContent = st ? st.name : 'Radio FM';
      }
    }

    var playBtn = $('btn-mini-play');
    if (playBtn) {
      playBtn.textContent = anyPlaying ? '❚❚' : '▶';
    }
  }

  function syncAudioVisualPulse() {
    var anyPlaying = isRadioPlaying || isYouTubePlaying();
    cockpit.classList.toggle('music-playing', anyPlaying);
    cockpit.classList.toggle('radio-active', isRadioPlaying);
    updateMiniPill();
  }

  function pauseYouTubeIfNeeded() {
    if (musicPlayer && musicReady && typeof musicPlayer.pauseVideo === 'function') {
      try {
        var st = musicPlayer.getPlayerState();
        if (st === 1 || st === 3) {
          musicPlayer.pauseVideo();
        }
      } catch (_) {}
    }
    updateMusicPlayButton();
    syncAudioVisualPulse();
  }

  function pauseRadioIfNeeded() {
    if (!radioAudio.paused || isRadioPlaying) {
      radioAudio.pause();
      isRadioPlaying = false;
      updateRadioUI('Paused');
    }
    syncAudioVisualPulse();
  }

  /* ================= TAB 1: LIVE RADIO FM PLAYER ================= */
  function updateRadioUI(statusText) {
    var st = stations[currentStationIndex] || stations[0];
    setText('stationName', st.name);
    if (statusText) setText('radioStatus', statusText);
    var select = $('stationSelect');
    if (select && Number(select.value) !== currentStationIndex) {
      select.value = String(currentStationIndex);
    }
    var playBtn = $('btn-radio-play');
    if (playBtn) {
      playBtn.textContent = isRadioPlaying ? '❚❚' : '▶';
    }
    syncAudioVisualPulse();
  }

  function loadAndPlayRadio(index) {
    if (index < 0) index = stations.length - 1;
    if (index >= stations.length) index = 0;
    currentStationIndex = index;

    activeAudioSource = 'radio';
    hasAudioActivated = true;
    miniPillDismissed = false;

    // Anti-bentrok: otomatis pause YouTube saat Radio diputar
    pauseYouTubeIfNeeded();

    var st = stations[currentStationIndex];
    try {
      radioAudio.pause();
      radioAudio.src = st.url;
      radioAudio.load();
      isRadioPlaying = false;
      updateRadioUI('Loading...');

      var playPromise = radioAudio.play();
      if (playPromise && typeof playPromise.then === 'function') {
        playPromise.then(function () {
          isRadioPlaying = true;
          updateRadioUI('Now Playing');
        }).catch(function () {
          isRadioPlaying = false;
          updateRadioUI('Stopped');
        });
      }
    } catch (e) {
      isRadioPlaying = false;
      updateRadioUI('Stopped');
    }
  }

  function toggleRadioPlayback() {
    activeAudioSource = 'radio';
    hasAudioActivated = true;
    miniPillDismissed = false;

    if (isRadioPlaying && !radioAudio.paused) {
      radioAudio.pause();
      isRadioPlaying = false;
      updateRadioUI('Paused');
    } else {
      if (!radioAudio.src) {
        loadAndPlayRadio(currentStationIndex);
      } else {
        pauseYouTubeIfNeeded();
        updateRadioUI('Loading...');
        radioAudio.play().then(function () {
          isRadioPlaying = true;
          updateRadioUI('Now Playing');
        }).catch(function () {
          loadAndPlayRadio(currentStationIndex);
        });
      }
    }
  }

  function setupRadioPlayer() {
    var select = $('stationSelect');
    var prevBtn = $('btn-radio-prev');
    var playBtn = $('btn-radio-play');
    var nextBtn = $('btn-radio-next');
    var muteBtn = $('btn-radio-mute');
    var volSlider = $('radio-volume');
    var volLabel = $('radio-volume-label');

    if (select) {
      select.innerHTML = '';
      stations.forEach(function (st, idx) {
        var opt = document.createElement('option');
        opt.value = String(idx);
        opt.textContent = (idx + 1) + '. ' + st.name;
        select.appendChild(opt);
      });
      select.addEventListener('change', function (e) {
        e.stopPropagation();
        loadAndPlayRadio(Number(select.value));
      });
    }

    radioAudio.volume = 0.8;

    radioAudio.addEventListener('playing', function () {
      isRadioPlaying = true;
      updateRadioUI('Now Playing');
    });

    radioAudio.addEventListener('waiting', function () {
      updateRadioUI('Loading...');
    });

    radioAudio.addEventListener('pause', function () {
      if (isRadioPlaying) {
        isRadioPlaying = false;
        updateRadioUI('Paused');
      }
    });

    radioAudio.addEventListener('error', function () {
      isRadioPlaying = false;
      updateRadioUI('Stopped');
    });

    if (playBtn) {
      playBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleRadioPlayback();
      });
    }

    if (prevBtn) {
      prevBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        loadAndPlayRadio(currentStationIndex - 1);
      });
    }

    if (nextBtn) {
      nextBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        loadAndPlayRadio(currentStationIndex + 1);
      });
    }

    if (volSlider) {
      volSlider.addEventListener('input', function () {
        var v = clamp(Number(volSlider.value), 0, 100);
        radioAudio.volume = v / 100;
        if (volLabel) volLabel.textContent = v + '%';
        if (v > 0 && radioAudio.muted) {
          radioAudio.muted = false;
          if (muteBtn) muteBtn.textContent = '🔊';
        }
      });
    }

    if (muteBtn) {
      muteBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        radioAudio.muted = !radioAudio.muted;
        muteBtn.textContent = radioAudio.muted ? '🔇' : '🔊';
      });
    }

    updateRadioUI('Stopped');
  }

  /* ================= TAB 2: YOUTUBE LINK & PLAYLIST PLAYER ================= */
  function formatMusicTime(seconds) {
    var n = Math.max(0, Math.floor(Number(seconds) || 0));
    var m = Math.floor(n / 60);
    var s = String(n % 60).padStart(2, '0');
    return m + ':' + s;
  }

  function extractYouTubeSource(input) {
    var raw = String(input || '').trim();
    if (!raw) return null;
    if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) return { type: 'video', id: raw };
    try {
      var url = new URL(raw);
      var host = url.hostname.toLowerCase();
      var isYoutube = host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be' || host.endsWith('.youtu.be');
      if (!isYoutube) return null;
      var watchId = url.searchParams.get('v');
      if (watchId && /^[a-zA-Z0-9_-]{11}$/.test(watchId)) return { type: 'video', id: watchId };
      var parts = url.pathname.split('/').filter(Boolean);
      var idx = parts.findIndex(function (p) { return ['embed', 'shorts', 'live'].includes(p); });
      if (idx >= 0 && parts[idx + 1] && /^[a-zA-Z0-9_-]{11}$/.test(parts[idx + 1])) return { type: 'video', id: parts[idx + 1] };
      if (host === 'youtu.be' && parts[0] && /^[a-zA-Z0-9_-]{11}$/.test(parts[0])) return { type: 'video', id: parts[0] };
    } catch (_) {}
    return null;
  }

  function youtubeThumbnail(id) {
    return 'https://i.ytimg.com/vi/' + encodeURIComponent(id) + '/hqdefault.jpg';
  }

  function loadMusicPlaylist() {
    try {
      var raw = localStorage.getItem(MUSIC_STORAGE_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) {
        musicPlaylist = parsed.filter(function (item) { return item && item.id; }).map(function (item) {
          return { id: String(item.id), title: String(item.title || 'YouTube Track') };
        });
      }
    } catch (_) {
      musicPlaylist = [];
    }
  }

  function saveMusicPlaylist() {
    try { localStorage.setItem(MUSIC_STORAGE_KEY, JSON.stringify(musicPlaylist)); } catch (_) {}
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function renderMusicPlaylist() {
    var list = $('music-playlist');
    if (!list) return;
    list.innerHTML = '';
    if (!musicPlaylist.length) {
      var empty = document.createElement('div');
      empty.className = 'music-empty';
      empty.textContent = 'Playlist kosong. Tekan + untuk menambah lagu.';
      list.appendChild(empty);
      return;
    }
    musicPlaylist.forEach(function (track, index) {
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'music-track-row' + (index === musicIndex ? ' active' : '');
      row.innerHTML =
        '<span class="music-track-thumb"><img src="' + youtubeThumbnail(track.id) + '" alt=""></span>' +
        '<span class="music-track-copy"><strong>' + escapeHtml(track.title) + '</strong></span>' +
        '<span class="music-track-index">' + String(index + 1).padStart(2, '0') + '</span>';
      row.addEventListener('click', function () { playMusicIndex(index); });
      list.appendChild(row);
    });
  }

  function updateMusicMeta() {
    var title = $('music-track-title');
    var subtitle = $('music-track-subtitle');
    var cover = $('music-cover');
    var placeholder = $('music-player-placeholder');
    var track = musicPlaylist[musicIndex];

    if (title) title.textContent = track ? track.title : 'Belum ada lagu';
    if (subtitle) subtitle.textContent = track ? 'YouTube • Playing' : 'Online Playback';
    if (cover) {
      if (track) {
        cover.src = youtubeThumbnail(track.id);
        cover.classList.add('show');
        cover.onerror = function () { cover.classList.remove('show'); };
      } else {
        cover.removeAttribute('src');
        cover.classList.remove('show');
      }
    }
    if (placeholder) placeholder.classList.toggle('hide', !!track);
    renderMusicPlaylist();
    updateMiniPill();
  }

  function updateMusicPlayButton() {
    var btn = $('btn-music-play');
    if (!btn) return;
    var state = musicPlayer && typeof musicPlayer.getPlayerState === 'function' ? musicPlayer.getPlayerState() : -1;
    btn.textContent = state === 1 ? '❚❚' : '▶';
    syncAudioVisualPulse();
  }

  function startMusicProgressLoop() {
    if (musicProgressTimer) return;
    musicProgressTimer = setInterval(function () {
      if (!musicPlayer || !musicReady) return;
      var current = 0, duration = 0;
      try {
        current = Number(musicPlayer.getCurrentTime()) || 0;
        duration = Number(musicPlayer.getDuration()) || 0;
      } catch (_) { return; }
      var progress = $('music-progress');
      var now = $('music-current-time');
      var end = $('music-duration');
      if (now) now.textContent = formatMusicTime(current);
      if (end) end.textContent = formatMusicTime(duration);
      if (progress) progress.value = duration > 0 ? String(Math.round((current / duration) * 1000)) : '0';
    }, 250);
  }

  function ensureYouTubeAPI() {
    if (window.YT && window.YT.Player) {
      musicApiReady = true;
      initializeYouTubePlayer();
      return;
    }
    if (window.__samcYouTubeApiLoading) return;
    window.__samcYouTubeApiLoading = true;
    window.onYouTubeIframeAPIReady = function () {
      musicApiReady = true;
      initializeYouTubePlayer();
    };
    var tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    tag.async = true;
    tag.onerror = function () {
      var subtitle = $('music-track-subtitle');
      if (subtitle) subtitle.textContent = 'API gagal dimuat. Cek koneksi internet.';
    };
    document.head.appendChild(tag);
  }

  function initializeYouTubePlayer() {
    if (!musicApiReady || musicPlayer || !$('youtube-player')) return;
    musicPlayer = new YT.Player('youtube-player', {
      width: '86',
      height: '48',
      videoId: musicPlaylist[0] ? musicPlaylist[0].id : '',
      playerVars: {
        playsinline: 1,
        rel: 0,
        modestbranding: 1,
        controls: 0,
        fs: 0,
        disablekb: 1,
        origin: window.location.origin
      },
      events: {
        onReady: function (event) {
          musicReady = true;
          event.target.setVolume(Number($('music-volume')?.value || 80));
          $('music-player-placeholder')?.classList.toggle('hide', !!musicPlaylist.length);
          updateMusicPlayButton();
          startMusicProgressLoop();
          if (musicPendingLoad !== null) {
            var pending = musicPendingLoad;
            musicPendingLoad = null;
            playMusicIndex(pending);
          }
        },
        onStateChange: function (event) {
          // Anti-bentrok: jika YouTube mulai PLAYING (1) atau BUFFERING (3), hentikan Radio FM
          if (event.data === YT.PlayerState.PLAYING || event.data === YT.PlayerState.BUFFERING) {
            activeAudioSource = 'youtube';
            hasAudioActivated = true;
            miniPillDismissed = false;
            pauseRadioIfNeeded();
          }
          updateMusicPlayButton();
          if (event.data === YT.PlayerState.ENDED) {
            playNextMusic(true);
          }
          var placeholder = $('music-player-placeholder');
          if (placeholder) placeholder.classList.toggle('hide', event.data !== YT.PlayerState.UNSTARTED || !musicPlaylist.length);
        },
        onError: function () {
          var subtitle = $('music-track-subtitle');
          if (subtitle) subtitle.textContent = 'Lagu diblokir / tidak dapat diputar.';
        }
      }
    });
  }

  function addMusicTrack(input, titleOverride) {
    var source = extractYouTubeSource(input);
    if (!source || source.type !== 'video') {
      alert('Masukkan link YouTube / ID 11 karakter yang valid.');
      return false;
    }
    var title = String(titleOverride || '').trim() || ('YouTube • ' + source.id);
    var existing = musicPlaylist.findIndex(function (item) { return item.id === source.id; });
    if (existing === -1) {
      musicPlaylist.push({ id: source.id, title: title });
      musicIndex = musicPlaylist.length - 1;
    } else {
      musicIndex = existing;
    }
    saveMusicPlaylist();
    renderMusicPlaylist();
    updateMusicMeta();
    playMusicIndex(musicIndex);
    return true;
  }

  function playMusicIndex(index) {
    index = Number(index);
    if (!Number.isInteger(index) || index < 0 || index >= musicPlaylist.length) return;
    activeAudioSource = 'youtube';
    hasAudioActivated = true;
    miniPillDismissed = false;
    pauseRadioIfNeeded();
    musicIndex = index;
    updateMusicMeta();

    if (!musicReady) {
      musicPendingLoad = index;
      ensureYouTubeAPI();
      return;
    }
    var track = musicPlaylist[index];
    try {
      musicPlayer.loadVideoById(track.id);
      musicPlayer.playVideo();
    } catch (_) {}

    $('music-player-placeholder')?.classList.add('hide');
  }

  function toggleMusicPlayback() {
    activeAudioSource = 'youtube';
    hasAudioActivated = true;
    miniPillDismissed = false;

    if (!musicReady) {
      if (!musicPlaylist.length) {
        menu.classList.add('open');
        $('tabBtnYoutube')?.click();
        $('music-add-row')?.classList.remove('hide');
        $('music-url-input')?.focus();
        return;
      }
      pauseRadioIfNeeded();
      ensureYouTubeAPI();
      if (musicIndex < 0) musicIndex = 0;
      musicPendingLoad = musicIndex;
      updateMiniPill();
      return;
    }
    var state = musicPlayer.getPlayerState();
    if (state === YT.PlayerState.PLAYING) {
      musicPlayer.pauseVideo();
    } else {
      pauseRadioIfNeeded();
      musicPlayer.playVideo();
    }
  }

  function playNextMusic(auto) {
    if (!musicPlaylist.length) return;
    if (musicRepeat && musicIndex >= 0) {
      playMusicIndex(musicIndex);
      return;
    }
    var next;
    if (musicShuffle && musicPlaylist.length > 1) {
      do { next = Math.floor(Math.random() * musicPlaylist.length); } while (next === musicIndex);
    } else {
      next = musicIndex + 1;
      if (next >= musicPlaylist.length) {
        if (auto) next = 0;
        else next = 0;
      }
    }
    playMusicIndex(next);
  }

  function playPrevMusic() {
    if (!musicPlaylist.length) return;
    var prev = musicIndex - 1;
    if (prev < 0) prev = musicPlaylist.length - 1;
    playMusicIndex(prev);
  }

  function setupAudioTabs() {
    var tabRadio = $('tabBtnRadio');
    var tabYoutube = $('tabBtnYoutube');
    var paneRadio = $('tabContentRadio');
    var paneYoutube = $('tabContentYoutube');

    function switchTab(target) {
      var isRadio = target === 'radio';
      tabRadio?.classList.toggle('active', isRadio);
      tabYoutube?.classList.toggle('active', !isRadio);
      tabRadio?.setAttribute('aria-selected', String(isRadio));
      tabYoutube?.setAttribute('aria-selected', String(!isRadio));
      paneRadio?.classList.toggle('active', isRadio);
      paneYoutube?.classList.toggle('active', !isRadio);
    }

    tabRadio?.addEventListener('click', function (e) {
      e.stopPropagation();
      switchTab('radio');
    });

    tabYoutube?.addEventListener('click', function (e) {
      e.stopPropagation();
      switchTab('youtube');
    });
  }

  /* ================= KONTROL FLOATING MINI AUDIO PILL ================= */
  function setupMiniAudioPill() {
    var prevBtn = $('btn-mini-prev');
    var playBtn = $('btn-mini-play');
    var nextBtn = $('btn-mini-next');
    var openBtn = $('btn-mini-open');
    var closeBtn = $('btn-mini-close');

    if (prevBtn) {
      prevBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (activeAudioSource === 'youtube') {
          playPrevMusic();
        } else {
          loadAndPlayRadio(currentStationIndex - 1);
        }
      });
    }

    if (playBtn) {
      playBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (activeAudioSource === 'youtube') {
          toggleMusicPlayback();
        } else {
          toggleRadioPlayback();
        }
      });
    }

    if (nextBtn) {
      nextBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (activeAudioSource === 'youtube') {
          playNextMusic(true);
        } else {
          loadAndPlayRadio(currentStationIndex + 1);
        }
      });
    }

    if (openBtn) {
      openBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        menu.classList.add('open');
        if (activeAudioSource === 'youtube') {
          $('tabBtnYoutube')?.click();
        } else {
          $('tabBtnRadio')?.click();
        }
      });
    }

    if (closeBtn) {
      closeBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        miniPillDismissed = true;
        updateMiniPill();
      });
    }
  }

  function setupMusicPlayer() {
    setupAudioTabs();
    setupRadioPlayer();
    setupMiniAudioPill();

    var play = $('btn-music-play');
    var next = $('btn-music-next');
    var prev = $('btn-music-prev');
    var mute = $('btn-music-mute');
    var volume = $('music-volume');
    var progress = $('music-progress');
    var addToggle = $('btn-music-add-toggle');
    var addRow = $('music-add-row');
    var addBtn = $('btn-music-add');
    var urlInput = $('music-url-input');
    var titleInput = $('music-title-input');
    var clear = $('btn-music-clear');
    var repeat = $('btn-music-repeat');
    var shuffle = $('btn-music-shuffle');

    loadMusicPlaylist();
    musicIndex = musicPlaylist.length ? 0 : -1;
    renderMusicPlaylist();
    updateMusicMeta();
    startMusicProgressLoop();

    if (play) play.addEventListener('click', function (e) { e.stopPropagation(); toggleMusicPlayback(); });
    if (next) next.addEventListener('click', function (e) { e.stopPropagation(); playNextMusic(false); });
    if (prev) prev.addEventListener('click', function (e) { e.stopPropagation(); playPrevMusic(); });

    if (volume) volume.addEventListener('input', function () {
      if (musicPlayer && musicReady) musicPlayer.setVolume(Number(volume.value));
    });

    if (mute) mute.addEventListener('click', function () {
      if (!musicPlayer || !musicReady) return;
      if (musicPlayer.isMuted()) {
        musicPlayer.unMute();
        mute.textContent = '🔊';
      } else {
        musicPlayer.mute();
        mute.textContent = '🔇';
      }
    });

    if (progress) progress.addEventListener('input', function () {
      if (!musicPlayer || !musicReady) return;
      var duration = Number(musicPlayer.getDuration()) || 0;
      if (duration > 0) musicPlayer.seekTo((Number(progress.value) / 1000) * duration, true);
    });

    if (addToggle) addToggle.addEventListener('click', function () {
      addRow?.classList.toggle('hide');
      urlInput?.focus();
    });

    var addFromInputs = function () {
      if (addMusicTrack(urlInput?.value || '', titleInput?.value || '')) {
        if (urlInput) urlInput.value = '';
        if (titleInput) titleInput.value = '';
        addRow?.classList.add('hide');
      }
    };

    if (addBtn) addBtn.addEventListener('click', addFromInputs);
    [urlInput, titleInput].forEach(function (el) {
      el?.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') addFromInputs();
      });
    });

    if (clear) clear.addEventListener('click', function () {
      musicPlaylist = [];
      musicIndex = -1;
      saveMusicPlaylist();
      renderMusicPlaylist();
      updateMusicMeta();
      if (musicPlayer && musicReady) musicPlayer.stopVideo();
      syncAudioVisualPulse();
    });

    if (repeat) repeat.addEventListener('click', function () {
      musicRepeat = !musicRepeat;
      repeat.classList.toggle('active', musicRepeat);
    });

    if (shuffle) shuffle.addEventListener('click', function () {
      musicShuffle = !musicShuffle;
      shuffle.classList.toggle('active', musicShuffle);
    });

    if (musicPlaylist.length) ensureYouTubeAPI();
  }

  /* ================= RENDER HUD 3 KOLOM ================= */
  function renderRPM() {
    var clampedRpm = clamp(S.rpm, 0, 8000);
    var progress = clampedRpm / 8000;
    var ladder = $('rpmLadder');
    if (ladder) ladder.setAttribute('aria-valuenow', String(Math.round(clampedRpm)));

    cockpit.classList.toggle('redline', progress > 0.85);

    if (bootSweepActive) return;
    var activeBars = S.engine ? Math.round(progress * RPM_SEGMENTS_COUNT) : 0;
    paintRPMSegments(activeBars);
  }

  function renderSpeed() {
    setText('speedValue', String(Math.round(S.speed)));
    var unitStr = S.speedMode === 1 ? 'mph' : (S.speedMode === 2 ? 'knots' : 'km/h');
    setText('speedUnit', unitStr);

    // Perhitungan kecepatan dalam MPH untuk ambang batas 60 MPH (~97 KM/H)
    var speedMPH = S.speedMode === 1 ? S.speed : (S.speedMS * 2.236936);
    var isOverspeed = speedMPH >= SPEED_LIMIT_MPH;

    // Hanya memicu soft red-amber glow visual tanpa suara alarm
    cockpit.classList.toggle('overspeed', isOverspeed);
  }

  function renderGear() {
    setText('gearValue', S.gear);
  }

  function renderHeadlights() {
    var el = $('headlightIndicator');
    if (el) {
      el.classList.remove('low-beam', 'high-beam');
      if (S.lights === 1) {
        el.classList.add('low-beam');
        el.title = 'Headlights: Low Beam';
      } else if (S.lights === 2) {
        el.classList.add('high-beam');
        el.title = 'Headlights: High Beam';
      } else {
        el.title = 'Headlights: Off';
      }
    }
    // Auto Night Mode saat lampu depan menyala
    cockpit.classList.toggle('night-mode', S.lights === 1 || S.lights === 2);
  }

  function renderIndicators() {
    var leftEl = $('leftIndicator');
    var rightEl = $('rightIndicator');
    if (leftEl) leftEl.classList.toggle('active', S.left);
    if (rightEl) rightEl.classList.toggle('active', S.right);
  }

  function renderOdometer() {
    setText('odometerValue', Math.max(0, S.odo).toFixed(1));
    setText('odoUnit', S.speedMode === 0 ? 'KM' : 'MI');
  }

  function updateEngineIconState() {
    var icon = $('engineCheck');
    if (!icon) return;
    icon.classList.remove('engine-ok', 'engine-warn', 'engine-danger');
    if (!S.engine) return;

    if (S.health <= 20) {
      icon.classList.add('engine-danger');
    } else if (S.health < 50) {
      icon.classList.add('engine-warn');
    } else {
      icon.classList.add('engine-ok');
    }
  }

  function renderEngine() {
    // Boot Sweep naik-turun singkat saat mesin dinyalakan
    if (!prevEngineState && S.engine) {
      runBootSweep();
    }
    prevEngineState = S.engine;

    cockpit.classList.toggle('engine-off', !S.engine);
    updateEngineIconState();
    renderRPM();
    updateBeltBeep();
  }

  function renderSeatbelt() {
    var icon = $('seatbeltIndicator');
    if (icon) {
      icon.classList.toggle('unbuckled', !S.belt);
      icon.classList.toggle('buckled', S.belt);
    }
  }

  function renderDoorLock() {
    var icon = $('doorLockIcon');
    var shackle = $('lockShackle');
    if (!icon || !shackle) return;

    if (S.locked) {
      icon.classList.remove('unlocked');
      icon.classList.add('locked');
      icon.title = 'Doors: Locked';
      shackle.setAttribute('d', 'M7 11V7a5 5 0 0 1 10 0v4');
    } else {
      icon.classList.remove('locked');
      icon.classList.add('unlocked');
      icon.title = 'Doors: Unlocked';
      shackle.setAttribute('d', 'M7 11V7a5 5 0 0 1 9.9-1');
    }

    if (prevLockedState !== null && prevLockedState !== S.locked) {
      icon.classList.remove('lock-snap');
      void icon.offsetWidth; // Force reflow untuk animasi lock snap
      icon.classList.add('lock-snap');
      if (lockSnapTimer) clearTimeout(lockSnapTimer);
      lockSnapTimer = setTimeout(function () {
        icon.classList.remove('lock-snap');
      }, 360);
    }
    prevLockedState = S.locked;
  }

  function renderFuel() {
    var f = clamp(S.fuel, 0, 100);
    setText('fuelValue', Math.round(f) + '%');
    var fill = $('fuelFill');
    if (fill) fill.style.width = f + '%';
    var block = $('fuelBlock');
    if (block) block.classList.toggle('critical', f <= 20);
  }

  function renderHealth() {
    var h = clamp(S.health, 0, 100);

    // Deteksi Impact Flash jika Health turun mendadak karena tabrakan
    if (prevHealthVal - h >= 2) {
      cockpit.classList.remove('impact-flash');
      void cockpit.offsetWidth; // Force reflow
      cockpit.classList.add('impact-flash');
      if (impactTimer) clearTimeout(impactTimer);
      impactTimer = setTimeout(function () {
        cockpit.classList.remove('impact-flash');
      }, 500);
    }
    prevHealthVal = h;

    setText('healthValue', Math.round(h) + '%');
    var fill = $('healthFill');
    if (fill) fill.style.width = h + '%';
    var block = $('healthBlock');
    if (block) block.classList.toggle('critical', h <= 20);

    updateEngineIconState();
  }

  /* ================= HOOKS SERVER FIVEM / NUI ================= */

  window.setEngine = function (engineState) {
    S.engine = Boolean(engineState);
    if (elements.engine) elements.engine.innerText = onOrOff(engineState);
    renderEngine();
  };

  window.setSpeed = function (speedMS) {
    var s = Number(speedMS);
    if (isNaN(s)) s = 0;
    S.speedMS = s;
    switch (S.speedMode) {
      case 1: S.speed = Math.round(s * 2.236936); break; // MPH
      case 2: S.speed = Math.round(s * 1.943844); break; // Knots
      default: S.speed = Math.round(s * 3.6); break;     // KM/H
    }
    if (elements.speed) {
      elements.speed.innerText = S.speed + ' ' + (S.speedMode === 1 ? 'MPH' : 'KMH');
    }
    renderSpeed();
  };

  window.setRPM = function (rpmVal) {
    var v = num(rpmVal);
    S.rpm = v <= 1.5 ? v * 8000 : v;
    if (elements.rpm) elements.rpm.innerText = (S.rpm / 8000).toFixed(4) + ' RPM';
    renderRPM();
  };

  window.setFuel = function (fuelVal) {
    var v = num(fuelVal);
    S.fuel = v > 0 && v <= 1 ? v * 100 : v;
    if (elements.fuel) elements.fuel.innerText = S.fuel.toFixed(1) + '%';
    renderFuel();
  };

  window.setHealth = function (healthVal) {
    var v = num(healthVal);
    S.health = v > 0 && v <= 1 ? v * 100 : (v > 100 ? v / 10 : v);
    if (elements.health) elements.health.innerText = S.health.toFixed(1) + '%';
    renderHealth();
  };

  window.setGear = function (gearVal) {
    S.gear = (gearVal === 0 || gearVal === '0') ? 'N' : String(gearVal).toUpperCase();
    if (elements.gear) elements.gear.innerText = String(gearVal);
    renderGear();
  };

  window.setHeadlights = function (lightState) {
    S.lights = num(lightState);
    if (elements.headlights) {
      elements.headlights.innerText = S.lights === 1 ? 'On' : (S.lights === 2 ? 'High Beam' : 'Off');
    }
    renderHeadlights();
  };

  window.setLeftIndicator = function (indicatorState) {
    S.left = Boolean(indicatorState);
    if (elements.indicators) {
      elements.indicators.innerText = (S.left ? 'On' : 'Off') + ' / ' + (S.right ? 'On' : 'Off');
    }
    renderIndicators();
  };

  window.setRightIndicator = function (indicatorState) {
    S.right = Boolean(indicatorState);
    if (elements.indicators) {
      elements.indicators.innerText = (S.left ? 'On' : 'Off') + ' / ' + (S.right ? 'On' : 'Off');
    }
    renderIndicators();
  };

  window.setSeatbelts = function (seatbeltState) {
    S.belt = Boolean(seatbeltState);
    if (elements.seatbelts) elements.seatbelts.innerText = onOrOff(seatbeltState);
    renderSeatbelt();
    updateBeltBeep();
  };

  function setDoorLock(state) {
    if (typeof state === 'string') {
      var norm = state.trim().toLowerCase();
      S.locked = norm === 'true' || norm === '1' || norm === 'locked' || norm === 'lock';
    } else if (typeof state === 'number') {
      S.locked = state >= 1;
    } else {
      S.locked = Boolean(state);
    }
    renderDoorLock();
  }

  window.setDoorLock = setDoorLock;
  window.setLocked = setDoorLock;
  window.setVehicleLock = setDoorLock;
  window.setDoorsLocked = setDoorLock;

  window.setSpeedMode = function (modeVal) {
    var m = String(modeVal).toLowerCase();
    if (m === 'mph' || m === '1') S.speedMode = 1;
    else if (m === 'knots' || m === 'knot' || m === '2') S.speedMode = 2;
    else if (m === 'kmh' || m === 'km/h' || m === '0') S.speedMode = 0;
    else S.speedMode = 0;
    window.setSpeed(S.speedMS);
    renderOdometer();
  };

  window.setOdometer = function (dist) {
    S.odo = num(dist);
    if (elements.odometer) elements.odometer.innerText = S.odo.toFixed(1) + ' Miles';
    renderOdometer();
  };

  /* ================= PENGATURAN HUD & LAYOUT ================= */
  function applyLayout() {
    cockpit.style.setProperty('--tx', L.tx + 'px');
    cockpit.style.setProperty('--ty', L.ty + 'px');
    cockpit.style.setProperty('--scale', L.scale);
    THEMES.forEach(function (t) { cockpit.classList.remove(t); });
    cockpit.classList.add(THEMES[L.theme] || THEMES[0]);
  }

  function clampLayout() {
    L.scale = clamp(L.scale, 0.5, 2);
    applyLayout();
    var r = cockpit.getBoundingClientRect();
    var vw = window.innerWidth, vh = window.innerHeight;
    if (r.left < 0) L.tx += -r.left;
    if (r.right > vw) L.tx -= (r.right - vw);
    if (r.top < 0) L.ty += -r.top;
    if (r.bottom > vh) L.ty -= (r.bottom - vh);
    applyLayout();
  }

  function saveLayout() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(L)); } catch (e) {}
  }

  function loadLayout() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var o = JSON.parse(raw);
      L.tx = num(o.tx);
      L.ty = num(o.ty);
      L.scale = clamp(num(o.scale, 1), 0.5, 2);
      L.theme = clamp(parseInt(o.theme, 10) || 0, 0, THEMES.length - 1);
    } catch (e) {}
  }

  var HINTS = {
    none: 'Pilih mode · klik kanan untuk menutup menu',
    move: 'Mode PINDAH: tahan & geser mouse untuk memindahkan HUD',
    resize: 'Mode RESIZE: geser mouse atau scroll untuk ubah ukuran',
    reset: 'Posisi & ukuran dikembalikan ke default'
  };

  function setMode(m, hintKey) {
    mode = m;
    cockpit.classList.toggle('mode-move', m === 'move');
    cockpit.classList.toggle('mode-resize', m === 'resize');
    var btns = menu.querySelectorAll('.menu-btns button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].getAttribute('data-act') === m);
    }
    if (hint) hint.textContent = HINTS[hintKey || m || 'none'];
  }

  menu.addEventListener('click', function (e) {
    var b = e.target.closest('.menu-btns button');
    if (!b || e.button !== 0) return;
    var act = b.getAttribute('data-act');
    if (act === 'move' || act === 'resize') {
      setMode(mode === act ? null : act);
    } else if (act === 'reset') {
      L.tx = 0; L.ty = 0; L.scale = 1;
      setMode(null, 'reset');
      clampLayout();
      saveLayout();
    } else if (act === 'theme') {
      L.theme = (L.theme + 1) % THEMES.length;
      applyLayout();
      saveLayout();
      if (hint) hint.textContent = 'Tema: ' + THEME_NAMES[L.theme];
    }
  });

  if (closeSettings) {
    closeSettings.addEventListener('click', function (e) {
      e.stopPropagation();
      menu.classList.remove('open');
      setMode(null);
      updateMiniPill();
    });
  }

  cockpit.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    var open = !menu.classList.contains('open');
    menu.classList.toggle('open', open);
    if (!open) setMode(null);
    else setMode(mode);
    updateMiniPill();
  });

  var drag = null;

  cockpit.addEventListener('mousedown', function (e) {
    if (e.button !== 0 || !mode) return;
    if (e.target.closest('#settingsMenu') || e.target.closest('#mini-music-pill')) return;
    e.preventDefault();
    drag = { x: e.clientX, y: e.clientY, tx: L.tx, ty: L.ty, scale: L.scale };
  });

  window.addEventListener('mousemove', function (e) {
    if (!drag) return;
    var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (mode === 'move') {
      L.tx = drag.tx + dx;
      L.ty = drag.ty + dy;
    } else if (mode === 'resize') {
      L.scale = drag.scale - dy / 220;
    }
    clampLayout();
  });

  window.addEventListener('mouseup', function () {
    if (!drag) return;
    drag = null;
    saveLayout();
  });

  window.addEventListener('wheel', function (e) {
    if (mode !== 'resize' || !menu.classList.contains('open')) return;
    e.preventDefault();
    L.scale += (e.deltaY < 0 ? 0.05 : -0.05);
    clampLayout();
    saveLayout();
  }, { passive: false });

  window.addEventListener('resize', function () { clampLayout(); });

  /* ================= INIT ================= */
  buildRPMLadder();
  loadLayout();
  clampLayout();
  setMode(null);
  setupMusicPlayer();

  window.setEngine(false);
  window.setSpeedMode('kmh');
  window.setSpeed(0);
  window.setRPM(0);
  window.setFuel(100);
  window.setHealth(100);
  window.setGear('N');
  window.setHeadlights(0);
  window.setLeftIndicator(false);
  window.setRightIndicator(false);
  window.setSeatbelts(false);
  window.setDoorLock(false);
  window.setOdometer(0);

  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || typeof d !== 'object') return;
    var payload = d.data && typeof d.data === 'object' ? d.data : d;

    var aliases = {
      engine: 'setEngine',
      speed: 'setSpeed',
      rpm: 'setRPM',
      fuel: 'setFuel',
      health: 'setHealth',
      gear: 'setGear',
      headlights: 'setHeadlights',
      leftIndicator: 'setLeftIndicator',
      rightIndicator: 'setRightIndicator',
      seatbelts: 'setSeatbelts',
      seatbelt: 'setSeatbelts',
      locked: 'setDoorLock',
      doorLock: 'setDoorLock',
      doorsLocked: 'setDoorLock',
      vehicleLock: 'setDoorLock',
      speedMode: 'setSpeedMode',
      odometer: 'setOdometer'
    };

    for (var key in aliases) {
      if (Object.prototype.hasOwnProperty.call(payload, key)) {
        var fn = window[aliases[key]];
        if (typeof fn === 'function') fn(payload[key]);
      }
    }
  });
})();