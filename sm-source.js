/* Study Monkey live source for CODEX STUDYS (cww).
 * - batches.json        -> built live from Study Monkey /api/batches
 * - data/sm-<id>.json   -> built live from /api/contents (folders -> chapters, videos -> lectures, PDFs -> notes)
 * - sm://course/video/parent lecture links are turned into a fresh stream link (/api/video-details) when played
 * The cww interface itself is untouched: this file only answers the app's own data requests.
 */
(function () {
  "use strict";
  var BASE = "https://studymonkeysf.netlify.app"; // Study Monkey site (API lives at BASE/api/*)
  var PFX = "sm-";
  var CACHE_TTL = 3 * 60 * 60 * 1000; // folder-tree cache: 3 hours (stream links are never cached)
  var origFetch = window.fetch.bind(window);
  var apiMode = null; // "proxy" (same-origin /sm-api/*) or "direct" (BASE/api/*), detected on first success

  /* ---------- API ---------- */
  function apiUrl(mode, path, qs) {
    return mode === "proxy" ? new URL("sm-api/" + path + qs, document.baseURI).href : BASE + "/api/" + path + qs;
  }
  async function api(path, params) {
    var qs = params ? "?" + new URLSearchParams(params).toString() : "";
    var modes = apiMode ? [apiMode] : ["proxy", "direct"];
    var err;
    for (var i = 0; i < modes.length; i++) {
      try {
        var r = await origFetch(apiUrl(modes[i], path, qs), { cache: "no-store" });
        if (!r.ok) throw new Error("HTTP " + r.status);
        var j = await r.json();
        apiMode = modes[i];
        return j;
      } catch (e) { err = e; }
    }
    throw err || new Error("Study Monkey API unavailable");
  }
  var streamProxy = function (u) { return apiUrl(apiMode || "direct", "stream", "?url=" + encodeURIComponent(u)); };

  /* ---------- batch list ---------- */
  var listPromise = null;
  function mapBatch(b) {
    return {
      _id: PFX + b.id, name: b.title || "Untitled batch",
      byName: [b.className, b.academicSession].filter(Boolean).join(" · ") || "Study Monkey",
      language: "", previewImage: b.thumbnail || "", type: "CW_BATCH", slug: PFX + b.id,
      lectureCount: 0, noteCount: 0, subBatches: [], __raw: b
    };
  }
  function loadList() {
    if (listPromise) return listPromise;
    listPromise = api("batches").then(function (d) {
      var arr = Array.isArray(d) ? d : [].concat((d && d.new) || [], (d && d.old) || []);
      var seen = {}, out = [];
      arr.forEach(function (b) { var k = String(b.id); if (!seen[k]) { seen[k] = 1; out.push(mapBatch(b)); } });
      return out;
    }).catch(function (e) { listPromise = null; throw e; });
    return listPromise;
  }
  async function batchesJson() {
    var local = [];
    try { var r = await origFetch("batches.json", { cache: "no-store" }); var j = await r.json(); local = (j && j.batches) || []; } catch (e) {}
    var sm = await loadList();
    return { success: true, batches: sm.map(function (b) { var c = Object.assign({}, b); delete c.__raw; return c; }).concat(local) };
  }

  /* ---------- batch tree (folders -> chapters) ---------- */
  var isFolder = function (it) { return String(it.material_type || it.type || "").toUpperCase() === "FOLDER"; };
  var titleOf = function (it) { return String(it.Title || it.title || "Untitled").trim(); };

  async function listFolder(cid, pid) {
    var last;
    for (var a = 0; a < 2; a++) {
      try {
        var r = await api("contents", { course_id: cid, parent_id: pid, start: 0 });
        if (r && r.status === 200 && Array.isArray(r.data)) return r.data;
        last = new Error((r && r.message) || "Invalid response");
      } catch (e) { last = e; }
    }
    throw last;
  }

  async function crawl(cid) {
    var nodes = {}, queue = [{ k: "root", pid: "-1", trail: [] }], active = 0; // Study Monkey root folder id is "-1" (not "root")
    await new Promise(function (resolve, reject) {
      var failed = false;
      function pump() {
        while (active < 6 && queue.length && !failed) {
          (function (job) {
            active++;
            listFolder(cid, job.pid).then(function (items) {
              var node = { pid: job.pid, trail: job.trail, items: items, kids: {} };
              nodes[job.k] = node;
              items.forEach(function (it) {
                if (isFolder(it) && job.trail.length < 8) {
                  var k = job.k + "/" + it.id;
                  node.kids[String(it.id)] = k;
                  queue.push({ k: k, pid: String(it.id), trail: job.trail.concat(titleOf(it)) });
                }
              });
            }).catch(function (e) {
              if (job.k === "root") { failed = true; reject(e); } else nodes[job.k] = { pid: job.pid, trail: job.trail, items: [], kids: {} };
            }).then(function () {
              active--;
              if (failed) return;
              if (!queue.length && !active) resolve(); else pump();
            });
          })(queue.shift());
        }
      }
      pump();
    });

    var groups = [], byName = {};
    function grp(name) {
      if (!byName[name]) { byName[name] = { n: name, lec: [], notes: [] }; groups.push(byName[name]); }
      return byName[name];
    }
    function emit(k) {
      var node = nodes[k]; if (!node) return;
      var name = node.trail.length ? node.trail.join(" › ") : "General";
      node.items.forEach(function (it) {
        var type = String(it.material_type || it.type || "").toUpperCase(), title = titleOf(it);
        if (type === "FOLDER") { if (node.kids[String(it.id)]) emit(node.kids[String(it.id)]); return; }
        if (type === "VIDEO") {
          var upcoming = parseInt(String(it.live_status)) === 2 || (!it.file_link && !it.duration_in_secs && !(it.livestream_links && it.livestream_links.length));
          if (!upcoming) grp(name).lec.push([title, "sm://" + cid + "/" + it.id + "/" + (node.pid || "root"), "v"]);
          if (it.pdf_link) grp(name).notes.push([title + " (PDF)", it.pdf_link]);
          return;
        }
        if (type === "PDF" || type === "NOTES") {
          var u = it.pdf_link || it.file_link || it.download_link || it.study_material_link;
          if (u) grp(name).notes.push([title, u]);
          return;
        }
        if (type === "IMAGE") { var iu = it.file_link || it.thumbnail; if (iu) grp(name).notes.push([title, iu]); return; }
        var lu = it.attach_link || it.embed_url || it.file_link;
        if (lu) grp(name).notes.push([title, lu]);
      });
    }
    emit("root");
    return {
      lectures: groups.filter(function (g) { return g.lec.length; }).map(function (g) { return { n: g.n, i: g.lec }; }),
      notes: groups.filter(function (g) { return g.notes.length; }).map(function (g) { return { n: g.n, i: g.notes }; })
    };
  }

  var treeMemo = {};
  async function loadBatch(id) {
    var cid = id.slice(PFX.length);
    var list = await loadList().catch(function () { return []; });
    var meta = list.filter(function (b) { return b._id === id; })[0];
    var key = "sm-tree2:" + cid, tree = null;
    try { var c = JSON.parse(localStorage.getItem(key) || "null"); if (c && Date.now() - c.t < CACHE_TTL) tree = c.d; } catch (e) {}
    if (!tree) {
      tree = await (treeMemo[cid] || (treeMemo[cid] = crawl(cid).catch(function (e) { delete treeMemo[cid]; throw e; })));
      try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), d: tree })); } catch (e) {}
    }
    var raw = (meta && meta.__raw) || {};
    return {
      id: id, name: (meta && meta.name) || "Study Monkey batch", by: (meta && meta.byName) || "Study Monkey",
      about: raw.description || raw.about || ((meta && meta.name) || "Batch") + " — recorded lectures and notes from Study Monkey.",
      lectures: tree.lectures, notes: tree.notes
    };
  }

  /* ---------- fetch interception (the app asks for batches.json and data/<id>.json) ---------- */
  var json = function (obj, status) { return new Response(JSON.stringify(obj), { status: status || 200, headers: { "Content-Type": "application/json" } }); };
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    var path = url.split("?")[0].split("#")[0];
    if (/(^|\/)batches\.json$/.test(path)) return batchesJson().then(function (o) { return json(o); }).catch(function () { return json({ success: false, batches: [] }, 503); });
    var m = path.match(/(^|\/)data\/(sm-[0-9a-z-]+)\.json$/i);
    if (m) return loadBatch(m[2]).then(function (o) { return json(o); }).catch(function () { return json({ error: "unavailable" }, 503); });
    return origFetch(input, init);
  };

  /* ---------- lecture player: resolve sm:// links to a fresh stream when played ---------- */
  if (typeof LecturePlayer !== "undefined" && LecturePlayer.prototype.setSrc) {
    var origSetSrc = LecturePlayer.prototype.setSrc;
    LecturePlayer.prototype.setSrc = function (url, t, play) {
      var m = typeof url === "string" && url.match(/^sm:\/\/([^/]+)\/([^/]+)\/([^/]+)$/);
      if (!m) return origSetSrc.call(this, url, t, play);
      var self = this, token = (self.__smTok = (self.__smTok || 0) + 1);
      var fresh = self.__smLast === url; // same lecture asked again (retry) -> ask for a fresh link
      self.__smLast = url;
      try { self.busy(1); self.r.classList.remove("failed"); } catch (e) {}
      var p = { course_id: decodeURIComponent(m[1]), video_id: decodeURIComponent(m[2]) };
      if (m[3] && m[3] !== "root") p.parent_id = decodeURIComponent(m[3]);
      if (fresh) p.fresh = "1";
      api("video-details", p).then(function (d) {
        if (token !== self.__smTok) return; // user already moved to another lecture
        if (!d || !d.success) throw new Error("Invalid video data received.");
        var yt = d.decoded_video_link || "";
        var real = null;
        if (yt && yt.indexOf("http") < 0 && yt.indexOf("/") < 0 && yt.length === 11) real = "https://www.youtube.com/watch?v=" + yt;
        else {
          var q = (d.qualities || []).filter(function (x) { return x && x.url; });
          real = (q[0] && q[0].url) || d.decoded_video_link || (d.livestream_links && d.livestream_links[0] && d.livestream_links[0].path) || null;
        }
        if (!real) throw new Error(d.playbackMessage || "Video stream link not found.");
        if (!/\.m3u8(\?|$)/i.test(real) && !/youtube\.com|youtu\.be/.test(real)) real = streamProxy(real);
        try { if (self.d) self.d.downloadUrl = /^https?:/.test(real) && !/youtube/.test(real) ? real : null; } catch (e) {}
        origSetSrc.call(self, real, t, play);
      }).catch(function (e) {
        if (token !== self.__smTok) return;
        try { self.err(String((e && e.message) || "Could not load this lecture")); } catch (x) {}
      });
    };
  }
})();
