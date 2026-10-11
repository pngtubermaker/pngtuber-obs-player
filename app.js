/*
 * The setup page: collect four frames, preview them with the microphone or
 * OBS, and build the single HTML file that goes into OBS. Everything happens
 * in this tab; no image or password leaves the computer.
 */
(function () {
  'use strict';

  var P = window.PNGTuberPlayer;
  var ROLES = P.ROLES;
  var LABELS = {
    idle: 'Idle',
    talking: 'Talking',
    blink: 'Blink',
    blinkTalking: 'Blink + talking',
  };
  /** Frames are scaled down to this on the long side to keep the file small. */
  var MAX_SIDE = 1024;

  var frames = {}; // role -> { url, width, height }
  var playerSource = null;
  var mic = null;
  var obs = null;
  var activeSample = null;

  function $(id) {
    return document.getElementById(id);
  }

  var player = P.mount($('preview-stage'), { frames: {} });
  player.onChange(function (state) {
    $('meter-bar').style.width = Math.round(state.level * 100) + '%';
  });

  fetch('player.js')
    .then(function (response) {
      if (!response.ok) throw new Error(String(response.status));
      return response.text();
    })
    .then(function (text) {
      playerSource = text;
      refresh();
    })
    .catch(function () {
      $('download-note').textContent =
        'Open this page from a web server (not as a local file) to build the OBS file.';
    });

  // --- Frames --------------------------------------------------------------

  /** Which frame a file name describes, or null if it doesn't say. */
  function roleFromName(fileName) {
    var name = fileName
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/, '')
      .replace(/[\s_]+/g, '-');
    var blink = /blink|eyes?-closed|closed-eyes?/.test(name);
    var talk = /talk|speak|scream|mouth-open|open-mouth/.test(name);
    if (blink && talk) return 'blinkTalking';
    if (blink) return 'blink';
    if (talk) return 'talking';
    if (/idle|neutral|quiet|default|rest/.test(name)) return 'idle';
    return null;
  }

  function loadImage(src) {
    var image = new Image();
    image.src = src;
    return image.decode().then(function () {
      return image;
    });
  }

  /** A file as a data URL, scaled to MAX_SIDE and re-encoded as WebP. */
  function encodeFile(file) {
    var objectUrl = URL.createObjectURL(file);
    return loadImage(objectUrl).then(function (image) {
      URL.revokeObjectURL(objectUrl);
      var scale = Math.min(
        1,
        MAX_SIDE / Math.max(image.naturalWidth, image.naturalHeight)
      );
      var width = Math.round(image.naturalWidth * scale);
      var height = Math.round(image.naturalHeight * scale);
      var canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(image, 0, 0, width, height);
      var url = canvas.toDataURL('image/webp', 0.92);
      // Browsers that can't write WebP return a PNG instead.
      if (url.indexOf('data:image/webp') !== 0) url = canvas.toDataURL('image/png');
      return { url: url, width: width, height: height };
    });
  }

  function readAsDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        resolve(reader.result);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function addFiles(fileList, forcedRole) {
    var files = Array.prototype.slice.call(fileList).filter(function (file) {
      return /^image\//.test(file.type);
    });
    if (!files.length) return;
    var taken = {};
    var plan = files.map(function (file) {
      var role = forcedRole || roleFromName(file.name);
      if (role && taken[role]) role = null;
      if (role) taken[role] = true;
      return { file: file, role: role };
    });
    // Unnamed files fill the slots nothing else claimed, in order.
    plan.forEach(function (item) {
      if (item.role) return;
      for (var i = 0; i < ROLES.length; i++) {
        if (!taken[ROLES[i]]) {
          item.role = ROLES[i];
          taken[ROLES[i]] = true;
          return;
        }
      }
    });
    setSample(null);
    Promise.all(
      plan
        .filter(function (item) {
          return item.role;
        })
        .map(function (item) {
          return encodeFile(item.file).then(function (frame) {
            frames[item.role] = frame;
          });
        })
    ).then(refresh);
  }

  function setSample(slug) {
    activeSample = slug;
    var buttons = document.querySelectorAll('.sample');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute(
        'aria-pressed',
        String(buttons[i].dataset.slug === slug)
      );
    }
  }

  function loadSample(sample) {
    setSample(sample.slug);
    var name = $('name');
    if (!name.value || name.dataset.fromSample === 'true') {
      name.value = sample.name;
      name.dataset.fromSample = 'true';
    }
    Promise.all(
      ROLES.map(function (role) {
        return fetch(sample.frames[role])
          .then(function (response) {
            return response.blob();
          })
          .then(readAsDataUrl)
          .then(function (url) {
            return loadImage(url).then(function (image) {
              return {
                role: role,
                frame: {
                  url: url,
                  width: image.naturalWidth,
                  height: image.naturalHeight,
                },
              };
            });
          });
      })
    ).then(function (loaded) {
      if (activeSample !== sample.slug) return;
      frames = {};
      loaded.forEach(function (item) {
        frames[item.role] = item.frame;
      });
      refresh();
    });
  }

  // --- Rendering the page ----------------------------------------------------

  function renderSlots() {
    var slots = $('slots');
    slots.textContent = '';
    ROLES.forEach(function (role) {
      var slot = document.createElement('button');
      slot.type = 'button';
      slot.className = 'slot';
      slot.title = 'Choose the ' + LABELS[role].toLowerCase() + ' frame';
      var picture;
      if (frames[role]) {
        picture = document.createElement('img');
        picture.src = frames[role].url;
        picture.alt = '';
      } else {
        picture = document.createElement('span');
        picture.className = 'blank';
      }
      slot.appendChild(picture);
      slot.appendChild(document.createTextNode(LABELS[role]));
      slot.onclick = function () {
        var input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/png,image/webp,image/jpeg';
        input.onchange = function () {
          addFiles(input.files, role);
        };
        input.click();
      };
      slot.ondragover = function (event) {
        event.preventDefault();
      };
      slot.ondrop = function (event) {
        event.preventDefault();
        addFiles(event.dataTransfer.files, role);
      };
      slots.appendChild(slot);
    });
  }

  function refresh() {
    renderSlots();
    var urls = {};
    ROLES.forEach(function (role) {
      if (frames[role]) urls[role] = frames[role].url;
    });
    player.setFrames(urls);
    $('preview-empty').hidden = !!frames.idle;

    var idle = frames.idle;
    var mismatch =
      idle &&
      ROLES.some(function (role) {
        var frame = frames[role];
        return frame && (frame.width !== idle.width || frame.height !== idle.height);
      });
    var warning = $('size-warning');
    warning.hidden = !mismatch;
    warning.textContent = mismatch
      ? "These frames aren't all the same size, so your character may jump when it talks."
      : '';

    var ready = !!(idle && playerSource);
    $('download').disabled = !ready;
    if (!idle) {
      $('download-note').textContent = 'Add your frames first.';
    } else if (playerSource) {
      var missing = ROLES.filter(function (role) {
        return !frames[role];
      }).map(function (role) {
        return LABELS[role].toLowerCase();
      });
      $('download-note').textContent =
        idle.width + ' × ' + idle.height + ' px, about ' + estimateMb() + ' MB.' +
        ' Use this size for the source in OBS.' +
        (missing.length
          ? ' Missing: ' + missing.join(', ') + ' (the nearest frame stands in).'
          : '');
    }
    $('password-note').hidden = !$('obs-password').value;
  }

  function estimateMb() {
    var bytes = 0;
    ROLES.forEach(function (role) {
      if (frames[role]) bytes += frames[role].url.length;
    });
    return (bytes / 1048576 + 0.05).toFixed(1);
  }

  // --- Listening -------------------------------------------------------------

  var MIC_STATUS = {
    live: 'Listening. Talk and watch the mouth.',
    denied: 'The browser blocked the microphone. Allow it from the address bar and try again.',
    unsupported: "This browser can't use the microphone on this page.",
  };

  var OBS_STATUS = {
    connecting: 'Connecting to OBS…',
    no_input: 'Connected, but OBS has no microphone source to listen to.',
    auth_required: 'OBS asks for a password. Enter it above and test again.',
    auth_failed: 'OBS refused that password.',
    unreachable:
      "Can't reach OBS. Is it open, with the WebSocket server enabled? Your browser may also ask to allow access to devices on your local network.",
    unsupported: 'This OBS is too old. Update to OBS 28 or newer.',
  };

  function stopMic() {
    if (!mic) return;
    mic.close();
    mic = null;
    $('test-mic').textContent = 'Test with my microphone';
    $('mic-status').textContent = '';
  }

  function stopObs() {
    if (!obs) return;
    obs.close();
    obs = null;
    $('test-obs').textContent = 'Test with OBS';
  }

  $('test-mic').onclick = function () {
    if (mic) return stopMic();
    stopObs();
    $('test-mic').textContent = 'Stop listening';
    mic = P.connectMic({
      onLevel: function (rms) {
        player.feed(rms, 'mic');
      },
      onStatus: function (status) {
        $('mic-status').textContent = MIC_STATUS[status] || '';
        if (status !== 'live') stopMicButton();
      },
    });
  };

  function stopMicButton() {
    mic = null;
    $('test-mic').textContent = 'Test with my microphone';
  }

  $('test-obs').onclick = function () {
    if (obs) {
      stopObs();
      $('obs-status').textContent = '';
      return;
    }
    stopMic();
    $('test-obs').textContent = 'Stop';
    obs = P.connectObs({
      port: Number($('obs-port').value) || 4455,
      password: $('obs-password').value,
      input: $('obs-input').value.trim(),
      onLevel: function (rms) {
        player.feed(rms, 'obs');
      },
      onStatus: function (status, detail) {
        $('obs-status').textContent =
          status === 'live'
            ? 'Connected. Listening to “' + detail + '”. Talk and watch the mouth.'
            : OBS_STATUS[status] || '';
        if (status === 'auth_required' || status === 'auth_failed' || status === 'unsupported') {
          stopObs();
        }
      },
    });
  };

  $('sensitivity').oninput = function () {
    var value = Number($('sensitivity').value);
    player.setSensitivity(value);
    $('sens-out').textContent = value.toFixed(1) + '×';
  };

  $('hold').oninput = function () {
    var value = Number($('hold').value);
    player.setHoldMs(value);
    $('hold-out').textContent = value + ' ms';
  };

  $('obs-password').oninput = refresh;

  $('name').oninput = function () {
    $('name').dataset.fromSample = 'false';
  };

  // --- The OBS file ----------------------------------------------------------

  function escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function slug(text) {
    return (
      text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'my-pngtuber'
    );
  }

  function buildObsFile(name, config) {
    var json = JSON.stringify(config).replace(/</g, '\\u003c');
    var script = playerSource.replace(/<\/script/gi, '<\\/script');
    return (
      '<!doctype html>\n' +
      '<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
      '<title>' + escapeHtml(name) + ' · PNGTuber for OBS</title>\n' +
      '<!-- Made with PNGTuber OBS Player: https://pngtubermaker.github.io/pngtuber-obs-player/\n' +
      '     Add this file to OBS as a Browser Source with "Local file" ticked.\n' +
      '     If you entered an OBS password, it is saved in this file: keep it to yourself. -->\n' +
      '<style>\n' +
      'html,body{margin:0;height:100%;background:transparent;overflow:hidden}\n' +
      '#stage{position:fixed;inset:0}\n' +
      '#stage img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;user-select:none}\n' +
      '#note{position:fixed;left:12px;right:12px;bottom:12px;margin:0;padding:12px 14px;border-radius:12px;' +
      'background:rgba(32,24,48,.9);color:#fff;font:600 16px/1.45 system-ui,sans-serif}\n' +
      '#try-mic{position:fixed;left:12px;top:12px;font:700 15px system-ui,sans-serif;padding:10px 14px;' +
      'border:0;border-radius:10px;background:#715a9b;color:#fff;cursor:pointer}\n' +
      '</style>\n</head>\n<body>\n' +
      '<div id="stage"></div>\n<p id="note" hidden></p>\n' +
      '<button id="try-mic" type="button" hidden>Test with my microphone</button>\n' +
      '<script>\n' + script + '\n</script>\n' +
      '<script id="config" type="application/json">' + json + '</script>\n' +
      "<script>PNGTuberPlayer.run(JSON.parse(document.getElementById('config').textContent));</script>\n" +
      '</body>\n</html>\n'
    );
  }

  $('download').onclick = function () {
    if (!frames.idle || !playerSource) return;
    var name = $('name').value.trim() || 'My PNGTuber';
    var urls = {};
    ROLES.forEach(function (role) {
      if (frames[role]) urls[role] = frames[role].url;
    });
    var html = buildObsFile(name, {
      name: name,
      frames: urls,
      sensitivity: Number($('sensitivity').value),
      holdMs: Number($('hold').value),
      obs: {
        port: Number($('obs-port').value) || 4455,
        password: $('obs-password').value,
        input: $('obs-input').value.trim(),
      },
    });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    link.download = 'pngtuber-' + slug(name) + '.html';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () {
      URL.revokeObjectURL(link.href);
    }, 10000);
  };

  // --- Wiring ----------------------------------------------------------------

  var drop = $('drop');
  $('files').onchange = function () {
    addFiles($('files').files);
    $('files').value = '';
  };
  drop.ondragover = function (event) {
    event.preventDefault();
    drop.classList.add('over');
  };
  drop.ondragleave = function () {
    drop.classList.remove('over');
  };
  drop.ondrop = function (event) {
    event.preventDefault();
    drop.classList.remove('over');
    addFiles(event.dataTransfer.files);
  };

  fetch('samples/samples.json')
    .then(function (response) {
      return response.json();
    })
    .then(function (samples) {
      var row = $('samples');
      samples.forEach(function (sample) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'sample';
        button.dataset.slug = sample.slug;
        button.setAttribute('aria-pressed', 'false');
        var face = document.createElement('img');
        face.src = sample.frames.idle;
        face.alt = '';
        button.appendChild(face);
        button.appendChild(document.createTextNode(sample.name));
        button.onclick = function () {
          loadSample(sample);
        };
        row.appendChild(button);
      });
    })
    .catch(function () {});

  refresh();
})();
