/*!
 * PNGTuber OBS Player — https://github.com/pngtubermaker/pngtuber-obs-player
 * MIT License. Made by PNGTuber Maker (https://pngtubermaker.net/).
 *
 * Plays a four-frame PNGTuber (idle, talking, blink, blink-talking) on a
 * transparent page: the mouth follows your voice and the eyes blink on their
 * own timer. Used twice: by the setup page for the preview, and inlined into
 * the single HTML file you add to OBS as a Browser Source.
 *
 * Where the voice comes from:
 *
 * 1. OBS itself, over obs-websocket v5 (built into OBS 28+). OBS's browser
 *    source refuses the microphone unless OBS was started with
 *    --enable-media-stream, but it can always reach 127.0.0.1, and OBS
 *    publishes every audio input's level as the InputVolumeMeters event.
 *    That level is measured after OBS's own filters, fader and mute, so a
 *    noise gate keeps working and a muted mic keeps the mouth shut.
 * 2. The browser microphone, as a fallback and for the setup page's test.
 */
(function (root) {
  'use strict';

  // --- The loudness curve -------------------------------------------------

  /** Room noise below this RMS never moves the mouth. */
  var NOISE_GATE = 0.012;
  /** Scales normal speech at desk distance to the top of the range. */
  var GAIN = 9;
  /** How fast the mouth closes, per 60 Hz frame. Open fast, close slow. */
  var CLOSE_RATE_PER_FRAME = 0.22;
  var REFERENCE_FRAME_MS = 1000 / 60;
  /** Above this smoothed level the mouth is open. */
  var TALK_THRESHOLD = 0.3;
  /**
   * Default gain per route. OBS's meter reads the input after its own fader
   * and without the automatic gain control the browser microphone gets, so
   * it needs more.
   */
  var MIC_SENSITIVITY = 1.4;
  var OBS_SENSITIVITY = 2;
  /**
   * OBS meters arrive every 50 ms; without a hold, a one-meter dip between
   * syllables would flap the mouth shut.
   */
  var DEFAULT_HOLD_MS = 100;

  function levelTarget(rms, sensitivity) {
    var gated = Math.max(0, rms - NOISE_GATE);
    return Math.min(1, gated * GAIN * sensitivity);
  }

  /** The next smoothed level: open at once, close over time. */
  function nextLevel(prev, rms, sensitivity, dtMs) {
    var target = levelTarget(rms, sensitivity);
    if (target > prev) return target;
    var frames = Math.max(0, dtMs) / REFERENCE_FRAME_MS;
    var keep = Math.pow(1 - CLOSE_RATE_PER_FRAME, frames);
    return target + (prev - target) * keep;
  }

  var QUIET = { talking: false, lastLoudAt: -Infinity };

  /**
   * Opens the moment the level crosses the threshold; closes only after it
   * has stayed below for holdMs.
   */
  function nextTalking(state, level, nowMs, holdMs) {
    if (level >= TALK_THRESHOLD) return { talking: true, lastLoudAt: nowMs };
    return {
      talking: state.talking && nowMs - state.lastLoudAt < holdMs,
      lastLoudAt: state.lastLoudAt,
    };
  }

  // --- Blinking ------------------------------------------------------------

  var BLINK_MS = 170;
  var BLINK_FIRST_MS = 2200;
  var BLINK_GAP_MIN_MS = 2400;
  var BLINK_GAP_JITTER_MS = 2600;

  function nextBlinkGap(random) {
    return BLINK_GAP_MIN_MS + random * BLINK_GAP_JITTER_MS;
  }

  // --- Frames --------------------------------------------------------------

  var ROLES = ['idle', 'talking', 'blink', 'blinkTalking'];

  /** The frame to show, falling back to the nearest one that exists. */
  function roleFor(frames, talking, blinking) {
    var order;
    if (talking && blinking) order = ['blinkTalking', 'talking', 'blink'];
    else if (talking) order = ['talking'];
    else if (blinking) order = ['blink'];
    else order = [];
    order.push('idle');
    for (var i = 0; i < order.length; i++) {
      if (frames[order[i]]) return order[i];
    }
    return null;
  }

  // --- SHA-256 -------------------------------------------------------------
  // OBS loads a local file from http://absolute/..., which is not a secure
  // context, so crypto.subtle may be missing exactly where the player runs.

  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  function ror(x, n) {
    return (x >>> n) | (x << (32 - n));
  }

  /** SHA-256 of a byte array, as 32 bytes. */
  function sha256(bytes) {
    var h = [
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
      0x1f83d9ab, 0x5be0cd19,
    ];
    var length = bytes.length;
    var padded = new Uint8Array((((length + 9 + 63) / 64) | 0) * 64);
    padded.set(bytes);
    padded[length] = 0x80;
    var view = new DataView(padded.buffer);
    var bits = length * 8;
    view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
    view.setUint32(padded.length - 4, bits >>> 0);
    var w = new Array(64);
    for (var offset = 0; offset < padded.length; offset += 64) {
      for (var i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
      for (i = 16; i < 64; i++) {
        var s0 = ror(w[i - 15], 7) ^ ror(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        var s1 = ror(w[i - 2], 17) ^ ror(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var a = h[0];
      var b = h[1];
      var c = h[2];
      var d = h[3];
      var e = h[4];
      var f = h[5];
      var g = h[6];
      var hh = h[7];
      for (i = 0; i < 64; i++) {
        var t1 =
          (hh +
            (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) +
            ((e & f) ^ (~e & g)) +
            K[i] +
            w[i]) |
          0;
        var t2 =
          ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) +
            ((a & b) ^ (a & c) ^ (b & c))) |
          0;
        hh = g;
        g = f;
        f = e;
        e = (d + t1) | 0;
        d = c;
        c = b;
        b = a;
        a = (t1 + t2) | 0;
      }
      h[0] = (h[0] + a) | 0;
      h[1] = (h[1] + b) | 0;
      h[2] = (h[2] + c) | 0;
      h[3] = (h[3] + d) | 0;
      h[4] = (h[4] + e) | 0;
      h[5] = (h[5] + f) | 0;
      h[6] = (h[6] + g) | 0;
      h[7] = (h[7] + hh) | 0;
    }
    var out = new Uint8Array(32);
    var outView = new DataView(out.buffer);
    for (i = 0; i < 8; i++) outView.setUint32(i * 4, h[i] >>> 0);
    return out;
  }

  function utf8(text) {
    return new TextEncoder().encode(text);
  }

  function base64(bytes) {
    var binary = '';
    for (var i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /**
   * obs-websocket's Identify authentication string:
   * base64(sha256(base64(sha256(password + salt)) + challenge)).
   */
  function obsAuthString(password, salt, challenge) {
    var secret = base64(sha256(utf8(password + salt)));
    return base64(sha256(utf8(secret + challenge)));
  }

  // --- obs-websocket v5 ----------------------------------------------------

  var OBS_DEFAULT_PORT = 4455;
  /** EventSubscription.InputVolumeMeters: high-volume, so asked for by bit. */
  var SUB_INPUT_VOLUME_METERS = 1 << 16;
  var RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 15000];
  /** With no microphone in OBS yet, look again this often. */
  var NO_INPUT_RETRY_MS = 15000;

  var MIC_INPUT_KINDS = [
    'wasapi_input_capture', // Windows
    'coreaudio_input_capture', // macOS
    'pulse_input_capture', // Linux (PulseAudio / PipeWire)
    'alsa_input_capture', // Linux (ALSA)
  ];

  /** What a socket close means, and whether trying again can help. */
  function closeCodeToStatus(code) {
    if (code === 4009) return { status: 'auth_failed', retry: false };
    if (code === 4010) return { status: 'unsupported', retry: false };
    return { status: 'unreachable', retry: true };
  }

  /**
   * The input to meter when none is named: the global Mic/Aux device if it
   * is set, else the first microphone-kind input. Newer OBS setups often
   * turn the global device off and add an Audio Input Capture instead.
   */
  function pickMicInput(special, inputs) {
    var keys = ['mic1', 'mic2', 'mic3', 'mic4'];
    for (var i = 0; i < keys.length; i++) {
      if (special && special[keys[i]]) return special[keys[i]];
    }
    for (i = 0; i < inputs.length; i++) {
      var kind = inputs[i].unversionedInputKind || inputs[i].inputKind || '';
      if (MIC_INPUT_KINDS.indexOf(kind) !== -1) return inputs[i].inputName;
    }
    return null;
  }

  /**
   * One input's level from a meter event: the loudest channel's magnitude.
   * Each channel is [magnitude x volume, peak x volume, raw input peak].
   * Index 2 ignores mute and the fader, so it must never move the mouth.
   * null when the input is absent: OBS lists only active inputs.
   */
  function micLevelFromMeters(inputs, inputName) {
    for (var i = 0; i < inputs.length; i++) {
      if (inputs[i].inputName !== inputName) continue;
      var level = 0;
      var channels = inputs[i].inputLevelsMul || [];
      for (var c = 0; c < channels.length; c++) {
        var magnitude = channels[c][0];
        if (isFinite(magnitude) && magnitude > level) level = magnitude;
      }
      return level;
    }
    return null;
  }

  /**
   * Meters one OBS input. Calls onLevel(rms) for every meter event and
   * onStatus(status, detail) when the connection changes:
   * connecting, live, no_input, auth_required, auth_failed, unreachable,
   * unsupported. Returns { close }.
   */
  function connectObs(opts) {
    var port = opts.port || OBS_DEFAULT_PORT;
    var password = opts.password || '';
    var wantedInput = opts.input || '';
    var inputName = null;
    var socket = null;
    var attempt = 0;
    var stopped = false;
    var retryTimer = null;
    var nextId = 1;
    var pending = {};

    function setStatus(status, detail) {
      if (!stopped) opts.onStatus(status, detail);
    }

    function send(message) {
      if (socket && socket.readyState === 1) socket.send(JSON.stringify(message));
    }

    function request(type, data) {
      return new Promise(function (resolve, reject) {
        var id = String(nextId++);
        pending[id] = { resolve: resolve, reject: reject };
        send({
          op: 6,
          d: { requestType: type, requestId: id, requestData: data || {} },
        });
      });
    }

    function pickInput() {
      Promise.all([request('GetSpecialInputs'), request('GetInputList')])
        .then(function (results) {
          var inputs = results[1].inputs || [];
          if (wantedInput) {
            var exists = inputs.some(function (input) {
              return input.inputName === wantedInput;
            });
            inputName = exists ? wantedInput : null;
          } else {
            inputName = pickMicInput(results[0], inputs);
          }
          if (inputName) {
            setStatus('live', inputName);
          } else {
            setStatus('no_input', wantedInput || null);
            retryTimer = setTimeout(pickInput, NO_INPUT_RETRY_MS);
          }
        })
        .catch(function () {});
    }

    function open() {
      if (stopped) return;
      setStatus('connecting');
      var terminal = false;
      try {
        socket = new WebSocket('ws://127.0.0.1:' + port);
      } catch (_error) {
        retry();
        return;
      }
      socket.onmessage = function (event) {
        var message;
        try {
          message = JSON.parse(event.data);
        } catch (_error) {
          return;
        }
        var d = message.d || {};
        if (message.op === 0) {
          var auth = d.authentication;
          if (auth && !password) {
            terminal = true;
            setStatus('auth_required');
            socket.close();
            return;
          }
          send({
            op: 1,
            d: {
              rpcVersion: 1,
              authentication: auth
                ? obsAuthString(password, auth.salt, auth.challenge)
                : undefined,
              eventSubscriptions: SUB_INPUT_VOLUME_METERS,
            },
          });
        } else if (message.op === 2) {
          attempt = 0;
          pickInput();
        } else if (message.op === 5) {
          if (d.eventType === 'InputVolumeMeters' && inputName) {
            var level = micLevelFromMeters(d.eventData.inputs || [], inputName);
            opts.onLevel(level === null ? 0 : level);
          }
        } else if (message.op === 7) {
          var waiting = pending[d.requestId];
          if (!waiting) return;
          delete pending[d.requestId];
          if (d.requestStatus && d.requestStatus.result) {
            waiting.resolve(d.responseData || {});
          } else {
            waiting.reject(d.requestStatus);
          }
        }
      };
      socket.onclose = function (event) {
        clearTimeout(retryTimer);
        pending = {};
        inputName = null;
        if (stopped || terminal) return;
        var outcome = closeCodeToStatus(event.code);
        setStatus(outcome.status);
        if (outcome.retry) retry();
      };
    }

    function retry() {
      var delay =
        RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
      attempt++;
      retryTimer = setTimeout(open, delay);
    }

    open();
    return {
      close: function () {
        stopped = true;
        clearTimeout(retryTimer);
        if (socket) socket.close();
      },
    };
  }

  // --- Browser microphone --------------------------------------------------

  /**
   * Reads the browser microphone's RMS every animation frame. Calls
   * onStatus with live, denied or unsupported. Returns { close }.
   */
  function connectMic(opts) {
    var stopped = false;
    var stream = null;
    var context = null;
    var frame = 0;
    var devices = root.navigator && root.navigator.mediaDevices;
    if (!devices || !devices.getUserMedia || !root.isSecureContext) {
      opts.onStatus('unsupported');
      return { close: function () {} };
    }
    devices
      .getUserMedia({ audio: true })
      .then(function (media) {
        if (stopped) {
          media.getTracks().forEach(function (track) {
            track.stop();
          });
          return;
        }
        stream = media;
        var AudioContextClass = root.AudioContext || root.webkitAudioContext;
        context = new AudioContextClass();
        var analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        context.createMediaStreamSource(media).connect(analyser);
        var buffer = new Float32Array(analyser.fftSize);
        opts.onStatus('live');
        var tick = function () {
          if (stopped) return;
          analyser.getFloatTimeDomainData(buffer);
          var sum = 0;
          for (var i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
          opts.onLevel(Math.sqrt(sum / buffer.length));
          frame = root.requestAnimationFrame(tick);
        };
        tick();
      })
      .catch(function () {
        opts.onStatus('denied');
      });
    return {
      close: function () {
        stopped = true;
        root.cancelAnimationFrame(frame);
        if (stream) {
          stream.getTracks().forEach(function (track) {
            track.stop();
          });
        }
        if (context) context.close();
      },
    };
  }

  // --- The stage -----------------------------------------------------------

  /**
   * Puts a character on `stage` and keeps the right frame showing.
   * Frames are stacked images and only visibility changes, so a swap never
   * waits for a decode.
   *
   * options: { frames: {idle, talking, blink, blinkTalking} (image URLs),
   *            sensitivity (multiplier, 1 = default), holdMs }
   */
  function mount(stage, options) {
    var frames = {};
    var images = {};
    var sensitivity = options.sensitivity || 1;
    var holdMs = options.holdMs == null ? DEFAULT_HOLD_MS : options.holdMs;
    var level = 0;
    var talk = QUIET;
    var blinking = false;
    var lastReadingAt = 0;
    var blinkTimer = null;
    var quietTimer = null;
    var listeners = [];
    var shown = null;

    stage.classList.add('pngtuber-stage');

    function render() {
      var role = roleFor(frames, talk.talking, blinking);
      if (role === shown) return;
      shown = role;
      for (var i = 0; i < ROLES.length; i++) {
        var image = images[ROLES[i]];
        if (image) image.style.visibility = ROLES[i] === role ? 'visible' : 'hidden';
      }
    }

    function notify() {
      for (var i = 0; i < listeners.length; i++) {
        listeners[i]({ level: level, talking: talk.talking, blinking: blinking });
      }
    }

    function setFrames(next) {
      frames = {};
      for (var i = 0; i < ROLES.length; i++) {
        var role = ROLES[i];
        var src = next[role];
        if (images[role]) {
          images[role].remove();
          delete images[role];
        }
        if (!src) continue;
        frames[role] = src;
        var image = document.createElement('img');
        image.alt = '';
        image.draggable = false;
        image.src = src;
        image.style.visibility = 'hidden';
        stage.appendChild(image);
        images[role] = image;
      }
      shown = null;
      render();
    }

    /** One audio reading. route is 'obs' or 'mic', which picks the gain. */
    function feed(rms, route) {
      var now = Date.now();
      var dt = lastReadingAt ? now - lastReadingAt : 50;
      lastReadingAt = now;
      var gain = (route === 'obs' ? OBS_SENSITIVITY : MIC_SENSITIVITY) * sensitivity;
      level = nextLevel(level, rms, gain, dt);
      talk = nextTalking(talk, level, now, holdMs);
      render();
      notify();
      // Readings can stop (OBS lists only active inputs): close the mouth
      // anyway once the hold has run out.
      clearTimeout(quietTimer);
      if (talk.talking || level > 0.001) {
        quietTimer = setTimeout(function () {
          feed(0, route);
        }, Math.max(holdMs, 50) + 150);
      }
    }

    function scheduleBlink(delay) {
      blinkTimer = setTimeout(function () {
        blinking = true;
        render();
        notify();
        blinkTimer = setTimeout(function () {
          blinking = false;
          render();
          notify();
          scheduleBlink(nextBlinkGap(Math.random()));
        }, BLINK_MS);
      }, delay);
    }

    setFrames(options.frames || {});
    scheduleBlink(BLINK_FIRST_MS);

    return {
      setFrames: setFrames,
      feed: feed,
      setSensitivity: function (value) {
        sensitivity = value;
      },
      setHoldMs: function (value) {
        holdMs = value;
      },
      onChange: function (listener) {
        listeners.push(listener);
      },
      destroy: function () {
        clearTimeout(blinkTimer);
        clearTimeout(quietTimer);
        for (var role in images) images[role].remove();
        images = {};
      },
    };
  }

  // --- The OBS file --------------------------------------------------------

  var HELP_SETTLE_MS = 2500;

  var HELP = {
    unreachable:
      "Can't reach OBS. In OBS, open Tools → WebSocket Server Settings and tick “Enable WebSocket server”.",
    auth_required:
      'OBS asks for a password. Make this file again on the setup page with the password from Tools → WebSocket Server Settings → Show Connect Info.',
    auth_failed:
      'OBS refused the password. Make this file again with the password from Tools → WebSocket Server Settings → Show Connect Info.',
    no_input:
      'OBS has no microphone to listen to. Add an Audio Input Capture source, or set Mic/Aux in Settings → Audio.',
    unsupported:
      'This OBS is too old to talk to. Update to OBS 28 or newer.',
    outside:
      'This is your PNGTuber for OBS. In OBS, add a Browser Source, tick “Local file” and choose this file.',
  };

  /**
   * Runs a character the way the downloaded OBS file does: OBS audio first,
   * the browser microphone if OBS cannot be heard, and a short setup note
   * that shows only until the mouth has moved once.
   */
  function run(config) {
    var stage = document.getElementById('stage');
    var note = document.getElementById('note');
    var player = mount(stage, config);
    var inObs = !!root.obsstudio;
    var everLive = false;
    var mic = null;
    var noteTimer = null;
    var noteReason = null;

    function showNote(text) {
      if (config.help === false || everLive) text = '';
      note.textContent = text;
      note.hidden = !text;
    }

    /**
     * Shows the note for `reason` once it has held for HELP_SETTLE_MS. The
     * first try to reach OBS on a cold start often fails and the retry works,
     * and a note flashing at every scene load is its own bug. Retries pass
     * through "connecting" and must not restart the clock.
     */
    function settleNote(reason) {
      if (everLive || reason === noteReason) return;
      noteReason = reason;
      clearTimeout(noteTimer);
      noteTimer = setTimeout(function () {
        showNote(HELP[reason] || '');
      }, HELP_SETTLE_MS);
    }

    function startMic() {
      if (mic) return;
      mic = connectMic({
        onLevel: function (rms) {
          player.feed(rms, 'mic');
        },
        onStatus: function (status) {
          if (status === 'live') {
            everLive = true;
            showNote('');
          }
        },
      });
    }

    if (!inObs) {
      showNote(HELP.outside);
      var button = document.getElementById('try-mic');
      if (button) {
        button.hidden = false;
        button.onclick = function () {
          button.hidden = true;
          startMic();
        };
      }
      return player;
    }

    connectObs({
      port: config.obs && config.obs.port,
      password: config.obs && config.obs.password,
      input: config.obs && config.obs.input,
      onLevel: function (rms) {
        player.feed(rms, 'obs');
      },
      onStatus: function (status) {
        if (status === 'live') {
          everLive = true;
          if (mic) {
            mic.close();
            mic = null;
          }
          clearTimeout(noteTimer);
          showNote('');
          return;
        }
        if (status === 'connecting') return;
        startMic();
        settleNote(status);
      },
    });
    return player;
  }

  var api = {
    mount: mount,
    run: run,
    connectObs: connectObs,
    connectMic: connectMic,
    // Pure parts, exported for the tests.
    levelTarget: levelTarget,
    nextLevel: nextLevel,
    nextTalking: nextTalking,
    QUIET: QUIET,
    roleFor: roleFor,
    sha256: sha256,
    obsAuthString: obsAuthString,
    closeCodeToStatus: closeCodeToStatus,
    pickMicInput: pickMicInput,
    micLevelFromMeters: micLevelFromMeters,
    ROLES: ROLES,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PNGTuberPlayer = api;
})(typeof window !== 'undefined' ? window : globalThis);
