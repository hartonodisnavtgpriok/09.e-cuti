(function () {
  var KEY = 'cuti_requests_v1';
  var currentUser = null;

  var SESSION_KEY = 'ecuti_session_v1';
  function saveSessionUser(u) {
    try { if (u && u.uid) localStorage.setItem(SESSION_KEY, JSON.stringify({uid: u.uid})); } catch(e){}
  }
  function clearSessionUser() {
    try { localStorage.removeItem(SESSION_KEY); } catch(e){}
  }
  function restoreSessionUser() {
    // AMAN: identitas & role tidak dipercaya dari localStorage.
    // Sesi dipulihkan oleh Supabase (INITIAL_SESSION -> finishLogin -> buildUser).
    try { localStorage.removeItem(SESSION_KEY); } catch(e){}
    return null;
  }

  var testUser = null, testApplicant = null;
  function activeUser() { return (testUser && isAdmin2()) ? testUser : currentUser; }
  var appConfig = window.ECUTI_CONFIG || {};
  var supabaseUrl = appConfig.supabaseUrl || '';
  var supabaseKey = appConfig.supabaseKey || '';
  var supabaseClient = null;
  var supabaseInitError = '';
  try {
    if (!supabaseUrl || !supabaseKey) {
      supabaseInitError = 'Konfigurasi Supabase belum tersedia. Salin config.example.js menjadi config.js lalu isi nilainya.';
    } else if (!window.supabase || !window.supabase.createClient) {
      supabaseInitError = 'Supabase tidak dapat dimuat. Periksa koneksi internet lalu muat ulang halaman.';
    } else {
      supabaseClient = window.supabase.createClient(supabaseUrl, supabaseKey);
    }
  } catch (error) {
    console.error('Supabase gagal diinisialisasi:', error);
    supabaseInitError = 'Supabase gagal diinisialisasi. Periksa konfigurasi URL dan publishable key.';
  }

  var STATUS = {
    pending_direct:        { label: 'Menunggu Persetujuan Tahap 1', cls: 'bg-yellow-100 text-yellow-800 border-yellow-300' },
    pending_next:          { label: 'Menunggu Persetujuan Tahap 2', cls: 'bg-blue-100 text-blue-800 border-blue-300' },
    pending_correspondence:{ label: 'Menunggu Persuratan', cls: 'bg-indigo-100 text-indigo-800 border-indigo-300' },
    pending_admin_issue:   { label: 'Menunggu Penerbitan Admin', cls: 'bg-purple-100 text-purple-800 border-purple-300' },
    issued:                { label: 'Surat Diterbitkan', cls: 'bg-green-100 text-green-800 border-green-300' },
    draft:                { label: 'Draft', cls: 'bg-slate-100 text-slate-700 border-slate-300' },
    pending:               { label: 'Pengajuan Lama', cls: 'bg-yellow-100 text-yellow-800 border-yellow-300' },
    admin_approved:        { label: 'Pengajuan Lama - Admin', cls: 'bg-blue-100 text-blue-800 border-blue-300' },
    approved:              { label: 'Disetujui (data lama)', cls: 'bg-green-100 text-green-800 border-green-300' },
    rejected:              { label: 'Ditolak', cls: 'bg-red-100 text-red-800 border-red-300' }
  };
  var TYPE_LABEL = { Annual: 'Annual (Tahunan)', Sick: 'Sick (Sakit)', Personal: 'Personal (Alasan Penting)', Besar: 'Cuti Besar', Melahirkan: 'Cuti Melahirkan', LuarTanggungan: 'Cuti di Luar Tanggungan Negara' };

  function isCurrentApprover(name) {
    return !!name && APPROVERS.some(function (person) { return person.name === name; });
  }
  function load() {
    try {
      return (JSON.parse(reqJson) || []).map(function (r) {
        if (r.status === 'pending' || r.status === 'admin_approved') r.status = 'pending_direct';
        if (r.status === 'approved') {
          r.status = 'pending_correspondence';
          r.firstApprovedAt = r.firstApprovedAt || r.createdAt;
          r.secondApprovedAt = r.secondApprovedAt || r.createdAt;
        }
        var routeNeedsRefresh = !r.firstApprover ||
          !Object.prototype.hasOwnProperty.call(r, 'secondApprover') ||
          (r.status === 'pending_direct' && !isCurrentApprover(r.firstApprover)) ||
          ((r.status === 'pending_direct' || r.status === 'pending_next') &&
            r.secondApprover && !isCurrentApprover(r.secondApprover));
        if (routeNeedsRefresh) {
          var employee = EMP.filter(function (person) { return person.nip === r.nip; })[0];
          if (employee) {
            var route = resolveRoute(employee);
            if (!r.firstApprover || (r.status === 'pending_direct' && !isCurrentApprover(r.firstApprover))) {
              r.firstApprover = route.first;
              r.firstApproverPosition = route.firstPosition;
            }
            if (!Object.prototype.hasOwnProperty.call(r, 'secondApprover') ||
              ((r.status === 'pending_direct' || r.status === 'pending_next') &&
                r.secondApprover && !isCurrentApprover(r.secondApprover))) {
              r.secondApprover = route.second;
              r.secondApproverPosition = route.secondPosition;
            }
          }
        }
        if (!r.firstApproverPosition && r.firstApprover) r.firstApproverPosition = positionForApprover(r.firstApprover);
        if (!r.secondApproverPosition && r.secondApprover) r.secondApproverPosition = positionForApprover(r.secondApprover);
        return r;
      });
    } catch (e) { return []; }
  }
  function save(list) {
    if (!supabaseClient) { toast(supabaseInitError || 'Supabase tidak tersedia. Muat ulang halaman.'); return false; }
    try {
      var next = JSON.parse(JSON.stringify(list));
      var prevById = {}, seen = {}, writes = 0;
      reqCache.forEach(function (r) { prevById[r.id] = JSON.stringify(r); });
      var changed = [];
      var deleted = [];
      next.forEach(function (r) {
        seen[r.id] = true;
        if (prevById[r.id] !== JSON.stringify(r)) {
          changed.push({ id: r.id, data: r });
          writes++;
        }
      });
      reqCache.forEach(function (r) {
        if (!seen[r.id]) { deleted.push(r.id); writes++; }
      });
      reqCache = next;
      reqJson = JSON.stringify(next);
      if (writes) {
        requestWriteQueue = requestWriteQueue.then(async function () {
          if (changed.length) {
            var upsertResult = await supabaseClient.from('leave_requests').upsert(changed);
            if (upsertResult.error) throw upsertResult.error;
          }
          if (deleted.length) {
            var deleteResult = await supabaseClient.from('leave_requests').delete().in('id', deleted);
            if (deleteResult.error) throw deleteResult.error;
          }
        }).catch(function (error) {
          console.error('Data pengajuan gagal disimpan ke Supabase:', error);
          toast('Data gagal disimpan ke server (' + (error.code || error.message || 'error') + ').');
          return false;
        });
      }
      return true;
    } catch (error) {
      console.error('Data pengajuan tidak dapat disimpan:', error);
      toast('Data pengajuan gagal disimpan.');
      return false;
    }
  }

  /* ---------- Sinkronisasi Supabase (data pengajuan dipakai bersama semua akun) ---------- */
  var reqCache = [], reqJson = '[]', reqUnsub = null, pendingRender = false;
  var requestWriteQueue = Promise.resolve();
  function safeRender() {
    var a = document.activeElement;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) { pendingRender = true; return; }
    renderAll();
  }
  document.addEventListener('focusout', function () {
    if (!pendingRender) return;
    setTimeout(function () {
      var a = document.activeElement;
      if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
      pendingRender = false; renderAll();
    }, 300);
  });
  function startRequestsSync() {
    if (!supabaseClient || reqUnsub) return;
    var channel = supabaseClient.channel('leave-requests')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'leave_requests' }, function () {
        loadRequestsFromServer();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'leave_balances' }, function () {
        loadLeaveBalancesFromServer().then(function (loaded) { if (loaded && currentUser) safeRender(); });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'app_settings' }, function () {
        loadSettingsFromServer().then(function () { if (currentUser) safeRender(); });
      })
      .subscribe(function (status, error) {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.error('Sinkronisasi realtime Supabase gagal:', error || status);
          toast('Sinkronisasi realtime gagal. Periksa konfigurasi Realtime dan RLS Supabase.');
        }
      });
    reqUnsub = function () { supabaseClient.removeChannel(channel); };
    loadRequestsFromServer();
  }
  async function loadRequestsFromServer() {
    if (!supabaseClient) return;
    try {
      var result = await supabaseClient.from('leave_requests').select('id,data');
      if (result.error) throw result.error;
      reqCache = (result.data || []).map(function (row) { return row.data; })
        .sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
      reqJson = JSON.stringify(reqCache);
      safeRender();
    } catch (error) {
      console.error('Gagal memuat data pengajuan dari Supabase:', error);
      toast('Gagal memuat data dari server (' + (error.code || error.message || 'error') + ').');
    }
  }
  function stopRequestsSync() {
    if (reqUnsub) { reqUnsub(); reqUnsub = null; }
    reqCache = []; reqJson = '[]';
  }

  /* ---------- Push notification (OneSignal) ---------- */
  var oneSignal = null, pushEnabled = false;
  var oneSignalReady = new Promise(function (resolve, reject) {
    window.OneSignalDeferred = window.OneSignalDeferred || [];
    window.OneSignalDeferred.push(async function (OneSignal) {
      try {
        if (!appConfig.oneSignalAppId) throw new Error('ID aplikasi OneSignal belum dikonfigurasi.');
        await OneSignal.init({ appId: appConfig.oneSignalAppId });
        oneSignal = OneSignal;
        OneSignal.Notifications.addEventListener('foregroundWillDisplay', function (event) {
          event.preventDefault(); // cegah notifikasi native browser agar tidak ganda dengan toast
          var notification = event.notification || {};
          toast((notification.title || 'Notifikasi') + ': ' + (notification.body || ''));
        });
        updatePushButton();
        resolve(OneSignal);
      } catch (error) {
        reject(error);
      }
    });
  });
  oneSignalReady.catch(function (error) { console.error('OneSignal gagal diinisialisasi:', error); });
  function pushSupported() { return !!(oneSignal && supabaseClient && 'serviceWorker' in navigator && 'Notification' in window); }
  function updatePushButton() {
    var b = document.getElementById('btn-push');
    if (!b) return;
    b.classList.toggle('hidden', !currentUser || !!testUser || !pushSupported());
    b.textContent = pushEnabled ? '🔔 Notifikasi aktif' : '🔕 Aktifkan notifikasi';
  }
  function registerPush(interactive) {
    if (!currentUser) return Promise.resolve(false);
    if (!supabaseClient || !('serviceWorker' in navigator) || !('Notification' in window)) {
      if (interactive) toast('Browser ini belum mendukung notifikasi push.');
      return Promise.resolve(false);
    }
    if (Notification.permission === 'denied') { if (interactive) toast('Notifikasi diblokir. Izinkan lewat pengaturan situs di browser.'); return Promise.resolve(false); }
    if (Notification.permission !== 'granted' && !interactive) return Promise.resolve(false);
    var user = currentUser;
    return oneSignalReady.then(function (client) {
      var ask = Notification.permission === 'granted'
        ? Promise.resolve()
        : client.Notifications.requestPermission();
      return ask.then(function () {
        if (Notification.permission !== 'granted') {
          if (interactive) toast('Izin notifikasi tidak diberikan.');
          return false;
        }
        if (!currentUser || currentUser.uid !== user.uid) return false;
        return client.login(user.uid).then(function () {
          if (!currentUser || currentUser.uid !== user.uid) return false;
          return supabaseClient.from('one_signal_users').upsert({
            user_id: user.uid, role: user.role, nip: user.nip, name: user.name, updated_at: new Date().toISOString()
          }).then(function (result) {
            if (result.error) throw result.error;
            pushEnabled = true;
            updatePushButton();
            if (interactive) toast('Notifikasi aktif untuk akun ini.');
            return true;
          });
        });
      });
    }).catch(function (error) {
      console.error('Registrasi OneSignal gagal:', error);
      if (interactive) toast('Gagal mengaktifkan notifikasi.');
      return false;
    });
  }
  function disconnectPush() {
    pushEnabled = false;
    updatePushButton();
    return oneSignalReady.then(function (client) {
      return client.logout();
    }).catch(function (error) {
      console.error('Logout OneSignal gagal:', error);
      return null;
    });
  }
  document.getElementById('btn-push').addEventListener('click', function () { registerPush(true); });

  /* ---------- Pengiriman push notification (memanggil Edge Function) ---------- */
  // Cari NIP berdasarkan nama di daftar penyetuju/persuratan/admin.
  function nipFromName(name, list) {
    var p = (list || []).filter(function (x) { return x.name === name; })[0];
    return p ? p.nip : '';
  }
  // Kirim push notification ke external_id (Supabase auth uid) tertentu.
  function sendPushNotification(externalId, title, body) {
    if (!externalId || !supabaseClient) return Promise.resolve(false);
    return supabaseClient.functions.invoke('send-push-notification', {
      body: { external_id: externalId, title: title, body: body, url: window.location.href.split('#')[0] }
    }).then(function (res) {
      if (res.error) { console.error('Kirim push gagal:', res.error); return false; }
      return true;
    }).catch(function (error) {
      console.error('Kirim push gagal:', error);
      return false;
    });
  }
  // Cari external_id dari tabel one_signal_users berdasarkan NIP, lalu kirim notifikasi.
  // Jika NIP tidak ditemukan / belum daftar push, lewati tanpa error.
  function notifyByNip(nip, title, body) {
    if (!supabaseClient || !nip) return Promise.resolve(false);
    return supabaseClient.from('one_signal_users').select('user_id').eq('nip', nip).limit(1)
      .then(function (result) {
        if (result.error || !result.data || !result.data.length) return false;
        return sendPushNotification(result.data[0].user_id, title, body);
      });
  }
  // Helper: kirim notifikasi ke pemohon pengajuan cuti.
  function notifyApplicant(request, title, body) {
    return notifyByNip(request.requestedBy || request.nip, title, body);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtDate(d) {
    if (!d) return '-';
    var p = d.split('-');
    var m = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
    return p[2] + ' ' + m[parseInt(p[1], 10) - 1] + ' ' + p[0];
  }
  function days(s, e) {
    return Math.round((new Date(e) - new Date(s)) / 86400000) + 1;
  }
  function badge(r) {
    var s = STATUS[r.status];
    if (!s) s = STATUS.pending_direct;
    var label = s.label;
    if (r.status === 'rejected' && r.rejectedBy) label = 'Ditolak oleh ' + r.rejectedBy;
    if (r.status === 'draft' && r.returnedBy) { label = 'Dikembalikan oleh ' + r.returnedBy; return '<span class="inline-block whitespace-nowrap text-xs font-semibold px-2.5 py-1 rounded-full border bg-amber-50 text-amber-800 border-amber-300">' + esc(label) + '</span>'; }
    return '<span class="inline-block whitespace-nowrap text-xs font-semibold px-2.5 py-1 rounded-full border ' + s.cls + '">' + esc(label) + '</span>';
  }
  function rejectedAtStage(r, stage) {
    if (r.rejectedStage) return r.rejectedStage === stage;
    return r.rejectedBy === (stage === 'first' ? 'Penyetuju Tahap 1' : 'Penyetuju Tahap 2');
  }
  function toast(msg) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove('show'); }, 2500);
  }
  function empty(icon, title, sub) {
    return '<div class="text-center py-10 text-slate-500"><div class="text-4xl mb-2">' + icon + '</div>' +
      '<p class="font-medium text-slate-700">' + title + '</p><p class="text-sm">' + sub + '</p></div>';
  }
  function statCard(label, val, color) {
    return '<div class="bg-white rounded-xl shadow p-4 border-l-4 ' + color + '"><p class="text-xs text-slate-500">' + label +
      '</p><p class="text-2xl font-bold">' + val + '</p></div>';
  }

  /* Generic table builder.
     cols: header strings; rows: array of arrays of html cells. Responsive: horizontal scroll. */
  function table(headers, rows) {
    var h = headers.map(function (x) {
      return '<th class="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">' + x + '</th>';
    }).join('');
    var b = rows.map(function (cells) {
      return '<tr class="border-t border-slate-100 hover:bg-slate-50">' + cells.map(function (c) {
        return '<td class="px-3 py-3 align-top text-sm">' + c + '</td>';
      }).join('') + '</tr>';
    }).join('');
    return '<div class="overflow-x-auto rounded-lg border border-slate-200"><table class="min-w-full"><thead class="bg-slate-50"><tr>' +
      h + '</tr></thead><tbody>' + b + '</tbody></table></div>';
  }
  function periodCell(r) {
    return fmtDate(r.start) + ' &ndash; ' + fmtDate(r.end) +
      '<div class="text-xs text-slate-500">' + days(r.start, r.end) + ' hari</div>' +
      ((r.attachments && r.attachments.length) ? '<div class="mt-1">' + btn('view-attach', r.id, '📎 Lampiran (' + r.attachments.length + ')', 'draft') + '</div>' : '');
  }
  function reasonCell(r) {
    return '<div class="max-w-xs break-words">' + esc(r.reason) + '</div>';
  }
  function btn(action, id, text, kind) {
    var _map = { ok:'bg-green-600 hover:bg-green-700 text-white', ex:'bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300', draft:'bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200', del:'bg-red-50 hover:bg-red-100 text-red-700 border border-red-200' };
    var c = _map[kind] || _map.ex;
    return '<button data-action="' + action + '" data-id="' + id + '" class="px-3 py-1.5 rounded-lg text-xs font-semibold transition ' + c + '">' + text + '</button>';
  }

  /* ---------- Renderers ---------- */
  var adminTab = 'pending';
  function renderAdmin() {
    var all = load().sort(function (a, b) { return b.createdAt - a.createdAt; });
    var user = activeUser();
    document.getElementById('admin-person-name').textContent = user && user.role === 'admin' ? '— ' + user.name : '';
    renderAdmin2ApproverManagement();
    var count = function (s) { return all.filter(function (r) { return r.status === s; }).length; };
    document.getElementById('admin-stats').innerHTML =
      statCard('Total Pengajuan', all.length, 'border-slate-500') +
      statCard('Siap Diterbitkan', count('pending_admin_issue'), 'border-purple-500') +
      statCard('Surat Diterbitkan', count('issued'), 'border-green-500') +
      statCard('Ditolak', count('rejected'), 'border-red-500');
    var list = all.filter(function (r) {
      if (adminTab === 'incoming') return r.status === 'pending_direct';
      if (adminTab === 'pending') return r.status === 'pending_admin_issue';
      if (adminTab === 'approved') return r.status === 'issued';
      return r.status === 'rejected';
    });
    document.querySelectorAll('.admin-tab').forEach(function (b) {
      var on = b.dataset.tab === adminTab;
      b.className = 'admin-tab px-4 py-2 rounded-lg text-sm font-semibold border transition ' +
        (on ? 'bg-blue-700 text-white border-blue-700' : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50');
    });
    document.getElementById('btn-exp-approved').classList.toggle('hidden', adminTab !== 'approved' || !canExportExcel());
    document.querySelector('[data-tab="incoming"]').classList.toggle('hidden', !isAdmin1());
    document.getElementById('admin-title').textContent = { pending: 'Pengajuan Siap Diterbitkan', approved: 'Surat yang Sudah Diterbitkan', rejected: 'Pengajuan yang Ditolak' }[adminTab];
    if (adminTab === 'incoming') document.getElementById('admin-title').textContent = 'Pengajuan Baru Menunggu Penyetuju Tahap 1';
    var el = document.getElementById('admin-table');
    if (!list.length) {
      el.innerHTML = adminTab === 'incoming' ? empty('📥', 'Tidak ada pengajuan baru', 'Pengajuan baru yang belum diproses tahap 1 akan tampil di sini.')
        : adminTab === 'pending' ? empty('📂', 'Belum ada surat untuk diterbitkan', 'Pengajuan yang sudah mendapat nomor surat dari Persuratan akan muncul di sini.')
        : adminTab === 'approved' ? empty('📁', 'Belum ada surat diterbitkan', 'Surat yang telah diterbitkan Admin akan tercatat di sini.')
        : empty('🚫', 'Belum ada pengajuan yang ditolak', 'Pengajuan yang ditolak pada salah satu tahap akan tercatat di sini.');
      return;
    }
    el.innerHTML = table(['Karyawan', 'Jenis', 'Periode', 'Alasan', 'Status', 'Aksi'], list.map(function (r) {
      var act = r.status === 'pending_admin_issue'
        ? btn('admin-issue', r.id, 'Terbitkan Surat', 'ok')
        : '<span class="text-xs text-slate-400">Sudah diproses</span>';
      if (adminTab === 'incoming' && currentUser && currentUser.role === 'admin' && currentUser.nip === ADMINS[0].nip) {
        act = btn('admin-edit-request', r.id, 'Edit Pengajuan', 'ok');
      }
      if (canExportExcel()) act += '<div class="mt-2">' + btn('export', r.id, '⬇ Formulir Excel', 'ex') + '</div>';
      if (canDownloadPdf(r)) act += '<div class="mt-2">' + btn('employee-pdf', r.id, '⬇ Unduh PDF', 'ok') + '</div>';
      return ['<span class="font-medium">' + esc(r.name) + '</span><div class="text-xs text-slate-500">Diajukan ' + new Date(r.createdAt).toLocaleDateString('id-ID') + '</div>',
        esc(TYPE_LABEL[r.type] || r.type), periodCell(r), reasonCell(r),
        badge(r) + (r.letterNumber ? '<div class="text-xs mt-1">No. ' + esc(r.letterNumber) + '</div>' : ''), act];
    }));
  }

  function renderApprover() {
    var user = activeUser();
    var profile = user && user.role === 'approver' ? approverByNip(user.nip) : null;
    var name = profile ? profile.name : '';
    var all = load().sort(function (a, b) { return b.createdAt - a.createdAt; });
    var firstPending = all.filter(function (r) { return r.status === 'pending_direct' && r.firstApprover === name; });
    var secondPending = all.filter(function (r) { return r.status === 'pending_next' && r.secondApprover === name; });
    var firstApproved = all.filter(function (r) { return r.firstApprover === name && !!r.firstApprovedAt; }).length;
    var secondApproved = all.filter(function (r) { return r.secondApprover === name && !!r.secondApprovedAt; }).length;
    var rejected = all.filter(function (r) { return r.rejectedBy === name; }).length;
    document.getElementById('approver-profile').innerHTML = profile
      ? '<p class="font-semibold text-blue-900">' + esc(profile.name) + '</p><p class="text-sm text-slate-600">' + esc(profile.title) + '</p><p class="text-sm text-slate-500">NIP ' + esc(profile.nip) + '</p>'
      : '<p class="text-sm text-slate-500">Identitas penyetuju tidak ditemukan.</p>';
    document.getElementById('approver-stats').innerHTML =
      statCard('Menunggu Keputusan', firstPending.length + secondPending.length, 'border-blue-500') +
      statCard('Disetujui Tahap 1', firstApproved, 'border-green-500') +
      statCard('Disetujui Tahap 2', secondApproved, 'border-indigo-500') +
      statCard('Ditolak', rejected, 'border-red-500');

    function renderQueue(targetId, requests, stage) {
      var stageLabel = stage === 'first' ? 'Tahap 1' : 'Tahap 2';
      document.getElementById(targetId).innerHTML = requests.length ? table(
        ['Karyawan / Unit', 'Jenis', 'Periode', 'Alasan', 'Status', 'Aksi'],
        requests.map(function (r) {
          return ['<span class="font-medium">' + esc(r.name) + '</span><div class="text-xs text-slate-500">' + esc(r.unit || '-') + '</div>',
            esc(TYPE_LABEL[r.type] || r.type), periodCell(r), reasonCell(r), badge(r),
            '<div class="flex flex-wrap gap-2">' + btn(stage + '-approve', r.id, 'Setujui ' + stageLabel, 'ok') +
              btn(stage + '-reject', r.id, 'Tolak', 'no') +
              (canExportExcel() ? btn('export', r.id, '⬇ Excel', 'ex') : '') + '</div>'];
        })
      ) : empty('✅', 'Tidak ada pengajuan menunggu', 'Pengajuan yang ditujukan kepada ' + esc(name || 'Anda') + ' akan tampil di sini.');
    }
    renderQueue('approver-first-pending', firstPending, 'first');
    renderQueue('approver-second-pending', secondPending, 'second');

    var history = all.filter(function (r) {
      return r.firstApprovedBy === name || r.secondApprovedBy === name || r.rejectedBy === name || r.returnedBy === name ||
        (r.firstApprover === name && r.firstApprovedAt && !r.firstApprovedBy) ||
        (r.secondApprover === name && r.secondApprovedAt && !r.secondApprovedBy);
    });
    document.getElementById('approver-history').innerHTML = history.length ? table(
      ['Tahap', 'Karyawan', 'Jenis', 'Periode', 'Status', 'Keputusan', 'Formulir'],
      history.map(function (r) {
        var stage = r.rejectedStage === 'second' || r.secondApprovedBy === name ? 'Tahap 2' : 'Tahap 1';
        var decidedAt = stage === 'Tahap 2' ? r.secondApprovedAt : (r.firstApprovedAt || r.returnedAt);
        return [stage, '<span class="font-medium">' + esc(r.name) + '</span>', esc(TYPE_LABEL[r.type] || r.type),
          periodCell(r), badge(r), decidedAt ? new Date(decidedAt).toLocaleDateString('id-ID') : '-',
          canExportExcel() ? btn('export', r.id, '⬇ Excel', 'ex') : '<span class="text-slate-400">—</span>'];
      })
    ) : empty('🗂️', 'Belum ada riwayat keputusan', 'Keputusan yang Anda ambil akan tercatat di sini.');
  }

  function suggestedLetterNumber(request, all) {
    var year = new Date(request.createdAt).getFullYear();
    var siblings = all.filter(function (r) { return new Date(r.createdAt).getFullYear() === year; })
      .sort(function (a, b) { return a.createdAt - b.createdAt; });
    var seq = siblings.indexOf(request) + 1;
    return 'CUTI/' + year + '/' + String(seq).padStart(4, '0');
  }

  /* ---------- Template catatan Penyetuju 1 ---------- */
  var FD_TEMPLATES = {
    A1: { kind: 'approve', text: 'Disetujui sesuai permohonan, pekerjaan telah didelegasikan kepada pegawai pengganti' },
    A2: { kind: 'approve', text: 'Disetujui, sisa hak cuti tahun berjalan mencukupi' },
    A3: { kind: 'approve', text: 'Disetujui, tidak mengganggu operasional dan pelayanan unit kerja' },
    A4: { kind: 'approve', text: 'Disetujui, telah melengkapi dokumen pendukung yang dipersyaratkan' },
    C1: { kind: 'return', text: 'Disetujui dengan perubahan tanggal, disesuaikan dengan jadwal operasional unit kerja' },
    C2: { kind: 'dates', text: 'Disetujui dengan perubahan, jumlah hari cuti dikurangi menjadi ... hari' },
    C3: { kind: 'return', text: 'Disetujui dengan perubahan, agar mengajukan kembali setelah menyelesaikan tugas prioritas' },
    C4: { kind: 'conditional', text: 'Disetujui bersyarat, menunggu penunjukan pegawai pengganti' }
  };
  var fdModal = document.getElementById('first-decision-modal');
  var fdRequestId = null, fdAutoNote = '';
  function fdEl(id) { return document.getElementById(id); }
  function closeFirstDecisionModal() {
    if (!fdModal) return;
    fdModal.classList.add('hidden'); fdModal.classList.remove('flex');
    fdRequestId = null; fdAutoNote = '';
  }
  function fdError(msg) {
    var el = fdEl('fd-error');
    el.textContent = msg || '';
    el.classList.toggle('hidden', !msg);
  }
  function fdCurrentRequest() { return load().filter(function (r) { return r.id === fdRequestId; })[0] || null; }
  function fdRefreshDates() {
    var r = fdCurrentRequest(), t = FD_TEMPLATES[fdEl('fd-template').value];
    if (!r || !t || t.kind !== 'dates') return;
    var s = fdEl('fd-start').value, e = fdEl('fd-end').value;
    var n = hitungHariKerja(s, e), old = hitungHariKerja(r.start, r.end);
    fdEl('fd-days-info').textContent = (s && e && n)
      ? 'Hari kerja baru: ' + n + ' hari (semula ' + old + ' hari kerja, ' + fmtDate(r.start) + ' s.d. ' + fmtDate(r.end) + ').'
      : 'Pilih tanggal mulai dan selesai yang baru (semula ' + fmtDate(r.start) + ' s.d. ' + fmtDate(r.end) + ', ' + old + ' hari kerja).';
    var noteEl = fdEl('fd-note');
    if (n && (noteEl.value === fdAutoNote || !noteEl.value.trim())) {
      fdAutoNote = t.text.replace('...', String(n));
      noteEl.value = fdAutoNote;
    }
  }
  function fdApplyTemplate() {
    var key = fdEl('fd-template').value, t = FD_TEMPLATES[key], r = fdCurrentRequest();
    var hint = fdEl('fd-hint'), submit = fdEl('fd-submit');
    fdError('');
    fdEl('fd-dates').classList.toggle('hidden', !(t && t.kind === 'dates'));
    if (!t) { fdEl('fd-note').value = ''; fdAutoNote = ''; hint.classList.add('hidden'); submit.textContent = 'Setujui & Teruskan'; return; }
    fdAutoNote = t.text; fdEl('fd-note').value = t.text;
    hint.classList.remove('hidden');
    if (t.kind === 'return') {
      hint.textContent = 'Permohonan akan dikembalikan kepada pengaju untuk menyesuaikan tanggal dan diajukan ulang. Belum diteruskan ke Penyetuju Tahap 2.';
      submit.textContent = 'Kembalikan ke Pengaju';
    } else if (t.kind === 'dates') {
      hint.textContent = 'Tanggal cuti pengaju akan diubah sesuai tanggal baru di bawah, lalu permohonan diteruskan ke tahap berikutnya.';
      submit.textContent = 'Ubah Tanggal & Teruskan';
      if (r) { fdEl('fd-start').value = r.start || ''; fdEl('fd-end').value = r.end || ''; }
      fdRefreshDates();
    } else if (t.kind === 'conditional') {
      hint.textContent = 'Permohonan diteruskan dengan catatan bersyarat; pengaju akan menerima catatan ini.';
      submit.textContent = 'Setujui Bersyarat & Teruskan';
    } else {
      hint.classList.add('hidden');
      submit.textContent = 'Setujui & Teruskan';
    }
  }
  function openFirstDecisionModal(id) {
    var user = activeUser();
    var r = load().filter(function (x) { return x.id === id; })[0];
    if (!user || user.role !== 'approver' || !r || r.firstApprover !== user.name) { toast('Tugas ini tidak ditugaskan kepada petugas yang sedang masuk.'); return; }
    if (r.status !== 'pending_direct') { renderAll(); toast('Status pengajuan sudah berubah. Muat ulang antrean sebelum memprosesnya.'); return; }
    fdRequestId = id; fdAutoNote = '';
    fdEl('fd-info').textContent = r.name + ' · ' + (TYPE_LABEL[r.type] || r.type) + ' · ' + fmtDate(r.start) + ' s.d. ' + fmtDate(r.end) + ' (' + hitungHariKerja(r.start, r.end) + ' hari kerja)';
    fdEl('fd-template').value = '';
    fdEl('fd-note').value = '';
    fdApplyTemplate();
    fdModal.classList.remove('hidden'); fdModal.classList.add('flex');
  }
  if (fdModal) {
    fdEl('fd-template').addEventListener('change', fdApplyTemplate);
    fdEl('fd-start').addEventListener('change', fdRefreshDates);
    fdEl('fd-end').addEventListener('change', fdRefreshDates);
    fdEl('fd-cancel').addEventListener('click', closeFirstDecisionModal);
    fdModal.addEventListener('click', function (e) { if (e.target === fdModal) closeFirstDecisionModal(); });
    fdEl('fd-submit').addEventListener('click', function () {
      var key = fdEl('fd-template').value, t = FD_TEMPLATES[key], r = fdCurrentRequest();
      var me = activeUser(), note = fdEl('fd-note').value.trim();
      if (!t) { fdError('Pilih template catatan terlebih dahulu.'); return; }
      if (!r || !me || me.role !== 'approver') { fdError('Pengajuan tidak ditemukan atau Anda tidak berwenang.'); return; }
      if (!note) { fdError('Catatan tidak boleh kosong.'); return; }
      var newStart = '', newEnd = '';
      if (t.kind === 'dates') {
        newStart = fdEl('fd-start').value; newEnd = fdEl('fd-end').value;
        if (!newStart || !newEnd) { fdError('Pilih tanggal mulai dan selesai yang baru.'); return; }
        if (newEnd < newStart) { fdError('Tanggal selesai tidak boleh sebelum tanggal mulai.'); return; }
        var nNew = hitungHariKerja(newStart, newEnd), nOld = hitungHariKerja(r.start, r.end);
        if (nNew < 1) { fdError('Rentang tanggal baru tidak memuat hari kerja.'); return; }
        if (nNew >= nOld) { fdError('Jumlah hari kerja baru (' + nNew + ') harus kurang dari semula (' + nOld + ').'); return; }
      }
      var snapshot = r, approverName = me.name, nowTs = Date.now();
      var ok = update(fdRequestId, 'pending_direct', function (x) {
        if (t.kind === 'return') {
          x.status = 'draft';
          x.returnedBy = approverName; x.returnedAt = nowTs; x.returnedNote = note;
          x.updatedAt = nowTs;
          return;
        }
        if (t.kind === 'dates') {
          if (!x.originalStart) { x.originalStart = x.start; x.originalEnd = x.end; }
          x.start = newStart; x.end = newEnd; x.datesChangedBy = approverName;
        }
        x.firstNote = note;
        x.firstDecision = (t.kind === 'approve') ? 'approve' : 'change';
        x.firstApprovedAt = nowTs;
        x.firstApprovedBy = approverName;
        x.status = x.secondApprover ? 'pending_next' : 'pending_correspondence';
      }, t.kind === 'return' ? 'Permohonan dikembalikan kepada pengaju.' : 'Persetujuan tahap 1 selesai dan pengajuan diteruskan.', function (x) {
        return x.firstApprover === approverName;
      });
      if (!ok) return;
      closeFirstDecisionModal();
      showView('approver');
      if (t.kind === 'return') {
        notifyApplicant(snapshot, 'Pengajuan dikembalikan', 'Pengajuan cuti Anda dikembalikan oleh ' + approverName + ': ' + note + ' Silakan ubah tanggal dan ajukan ulang.');
        return;
      }
      notifyApplicant(snapshot, 'Pengajuan disetujui Tahap 1',
        'Pengajuan cuti Anda disetujui oleh ' + approverName + ' (Tahap 1). Catatan: ' + note +
        (t.kind === 'dates' ? ' Tanggal cuti diubah menjadi ' + fmtDate(newStart) + ' s.d. ' + fmtDate(newEnd) + '.' : ''));
      if (snapshot.secondApprover) {
        notifyByNip(nipFromName(snapshot.secondApprover, APPROVERS), 'Pengajuan menunggu persetujuan Anda',
          'Pengajuan cuti dari ' + snapshot.name + ' menunggu persetujuan Anda (Tahap 2).');
      }
    });
  }

  var letterNumberRequestId = null;
  var letterNumberModal = document.getElementById('letter-number-modal');
  var letterNumberValue = document.getElementById('letter-number-value');
  function closeLetterNumberModal(fromPop) {
    if (!letterNumberModal.classList.contains('hidden')) {
      letterNumberModal.classList.add('hidden');
      letterNumberModal.classList.remove('flex');
      letterNumberRequestId = null;
      if (!fromPop && history.state && history.state.modal === 'letter') {
        try { history.back(); } catch (e) {}
      }
    }
  }
  function openLetterNumberModal(id) {
    var user = activeUser();
    if (!user || user.role !== 'correspondence') {
      toast('Hanya petugas Persuratan yang dapat menerbitkan nomor surat.');
      return;
    }
    var all = load();
    var request = all.filter(function (r) { return r.id === id && r.status === 'pending_correspondence'; })[0];
    if (!request) { toast('Pengajuan tidak ditemukan atau sudah diproses.'); renderAll(); return; }
    letterNumberRequestId = id;
    document.getElementById('letter-number-requester').textContent = request.name + ' · ' + (request.unit || 'Unit kerja tidak tersedia');
    letterNumberValue.value = suggestedLetterNumber(request, all);
    document.getElementById('letter-number-error').classList.add('hidden');
    letterNumberModal.classList.remove('hidden');
    letterNumberModal.classList.add('flex');
    letterNumberValue.focus();
    letterNumberValue.select();
    try { history.pushState({ modal: 'letter', view: (history.state && history.state.view) || 'home' }, ''); } catch (e) {}
  }
  document.getElementById('letter-number-cancel').addEventListener('click', function () { closeLetterNumberModal(); });
  letterNumberModal.addEventListener('click', function (e) {
    if (e.target === letterNumberModal) closeLetterNumberModal();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !letterNumberModal.classList.contains('hidden')) closeLetterNumberModal();
  });
  document.getElementById('letter-number-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var user = activeUser();
    if (!user || user.role !== 'correspondence') {
      toast('Hanya petugas Persuratan yang dapat menerbitkan nomor surat.');
      closeLetterNumberModal();
      return;
    }
    var id = letterNumberRequestId;
    var number = letterNumberValue.value.trim();
    var error = document.getElementById('letter-number-error');
    if (!id || !number) {
      error.textContent = 'Nomor surat wajib diisi.';
      error.classList.remove('hidden');
      return;
    }
    if (load().some(function (r) { return r.id !== id && r.letterNumber === number; })) {
      error.textContent = 'Nomor surat tersebut sudah digunakan. Masukkan nomor yang berbeda.';
      error.classList.remove('hidden');
      return;
    }
    var numberedReq = load().filter(function (r) { return r.id === id; })[0];
    var issued = update(id, 'pending_correspondence', function (r) {
      r.letterNumber = number;
      r.letterNumberIssuedAt = Date.now();
      r.correspondenceOfficer = user && user.role === 'correspondence' ? user.name : 'Persuratan';
      r.status = 'pending_admin_issue';
    }, 'Nomor surat diterbitkan. Nomor ini otomatis tercantum di formulir cuti.');
    if (issued) {
      closeLetterNumberModal();
      showView('admin');
      if (numberedReq) {
        notifyApplicant(numberedReq, 'Nomor surat terbit',
          'Nomor surat cuti Anda (' + number + ') telah diterbitkan, menunggu penerbitan oleh Admin.');
        ADMINS.forEach(function (a) {
          notifyByNip(a.nip, 'Surat cuti siap diterbitkan',
            'Surat cuti ' + numberedReq.name + ' (No. ' + number + ') siap diterbitkan.');
        });
      }
    }
  });

  function renderCorrespondence() {
    var user = activeUser();
    var profile = user && user.role === 'correspondence'
      ? CORRESPONDENCE.filter(function (person) { return person.nip === user.nip; })[0]
      : null;
    document.getElementById('correspondence-profile').innerHTML = profile
      ? '<p class="font-semibold text-blue-900">' + esc(profile.name) + '</p><p class="text-sm text-slate-600">' + esc(profile.title) + '</p><p class="text-sm text-slate-500">NIP ' + esc(profile.nip) + '</p>'
      : '<p class="text-sm text-slate-500">Identitas persuratan tidak ditemukan.</p>';
    var all = load().sort(function (a, b) { return b.createdAt - a.createdAt; });
    var pend = all.filter(function (r) { return r.status === 'pending_correspondence'; });
    var numbered = all.filter(function (r) { return r.letterNumber; });
    document.getElementById('correspondence-stats').innerHTML =
      statCard('Menunggu Nomor', pend.length, 'border-indigo-500') +
      statCard('Nomor Terbit', numbered.length, 'border-green-500') +
      statCard('Menunggu Admin', all.filter(function (r) { return r.status === 'pending_admin_issue'; }).length, 'border-purple-500');
    document.getElementById('correspondence-pending').innerHTML = pend.length ? table(['Karyawan', 'Jenis', 'Periode', 'Status', 'Aksi'], pend.map(function (r) {
      return ['<span class="font-medium">' + esc(r.name) + '</span>', esc(TYPE_LABEL[r.type] || r.type), periodCell(r), badge(r),
        btn('correspondence-issue-number', r.id, 'Terbitkan Nomor', 'ok')];
    })) : empty('📨', 'Tidak ada pengajuan menunggu nomor', 'Pengajuan yang sudah melewati seluruh tahap persetujuan akan tampil di sini.');
    document.getElementById('correspondence-history').innerHTML = numbered.length ? table(['Karyawan', 'Jenis', 'Nomor Surat', 'Status', 'Tanggal Terbit', 'Surat'], numbered.map(function (r) {
      return ['<span class="font-medium">' + esc(r.name) + '</span>', esc(TYPE_LABEL[r.type] || r.type),
        '<span class="font-semibold">' + esc(r.letterNumber) + '</span>', badge(r),
        r.letterNumberIssuedAt ? new Date(r.letterNumberIssuedAt).toLocaleDateString('id-ID') : '-',
        canDownloadPdf(r) ? btn('employee-pdf', r.id, '⬇ Unduh PDF', 'ok') : '<span class="text-xs text-slate-400">—</span>'];
    })) : empty('📭', 'Belum ada nomor surat terbit', 'Nomor yang diterbitkan Persuratan akan tercatat di sini.');
  }

  /* ---------- Pemberitahuan dalam aplikasi (lonceng) ---------- */
  var notifLastCount = -1, notifLastUser = '';
  function notifSeenKey() { var u = activeUser(); return 'cuti_notif_seen_v1_' + (u ? (u.nip || u.uid || u.name) : ''); }
  function loadSeen() { try { return JSON.parse(localStorage.getItem(notifSeenKey()) || '{}') || {}; } catch (e) { return {}; } }
  function saveSeen(m) { try { localStorage.setItem(notifSeenKey(), JSON.stringify(m)); } catch (e) {} }
  function buildNotifications() {
    var u = activeUser(); if (!u) return [];
    var out = [], approverName = u.role === 'approver' ? approverNameForUser(u) : '';
    function add(r, kind, text, time, tone, view) {
      out.push({ key: r.id + ':' + kind + ':' + (time || 0), text: text, time: time || r.createdAt || 0, tone: tone, view: view });
    }
    load().forEach(function (r) {
      if (r.requestedBy ? r.requestedBy === u.nip : r.nip === u.nip) {
        var rejStage = r.rejectedStage === 'second' ? 'Tahap 2' : 'Tahap 1';
        if (r.status === 'issued') add(r, 'issued', 'Surat cuti Anda telah diterbitkan. Buka riwayat pengajuan untuk mengunduh PDF.', r.issuedAt, 'ok', 'employee');
        else if (r.status === 'rejected') add(r, 'rejected', 'Pengajuan cuti Anda ditolak oleh ' + (r.rejectedBy || 'penyetuju') + ' (' + rejStage + ').', r.rejectedAt, 'no', 'employee');
        else if (r.status === 'pending_admin_issue') add(r, 'numbered', 'Nomor surat terbit' + (r.letterNumber ? ' (' + r.letterNumber + ')' : '') + ', menunggu penerbitan oleh Admin.', r.letterNumberIssuedAt, 'info', 'employee');
        else if (r.status === 'pending_correspondence') add(r, 'approved', 'Pengajuan Anda disetujui, menunggu nomor surat dari Persuratan.', r.secondApprovedAt || r.firstApprovedAt, 'info', 'employee');
        else if (r.status === 'pending_next') add(r, 'first', 'Disetujui Tahap 1 oleh ' + (r.firstApprovedBy || r.firstApprover) + ', menunggu Tahap 2.', r.firstApprovedAt, 'info', 'employee');
        else if (r.status === 'pending_direct') add(r, 'sent', 'Pengajuan terkirim, menunggu persetujuan ' + r.firstApprover + ' (Tahap 1).', r.createdAt, 'info', 'employee');
      }
      if (approverName && r.status === 'pending_direct' && r.firstApprover === approverName)
        add(r, 'todo1', 'Pengajuan baru dari ' + r.name + ' menunggu persetujuan Anda (Tahap 1).', r.createdAt, 'todo', 'approver');
      if (approverName && r.status === 'pending_next' && r.secondApprover === approverName)
        add(r, 'todo2', 'Pengajuan ' + r.name + ' menunggu persetujuan Anda (Tahap 2).', r.firstApprovedAt, 'todo', 'approver');
      if (u.role === 'correspondence' && r.status === 'pending_correspondence')
        add(r, 'todonum', 'Pengajuan ' + r.name + ' menunggu nomor surat.', r.secondApprovedAt || r.firstApprovedAt, 'todo', 'correspondence');
      if (u.role === 'admin' && r.status === 'pending_admin_issue')
        add(r, 'todoissue', 'Surat cuti ' + r.name + ' siap diterbitkan.', r.letterNumberIssuedAt, 'todo', 'admin');
    });
    out.sort(function (a, b) { return b.time - a.time; });
    return out.slice(0, 40);
  }
  var NOTIF_TONE = { ok: 'bg-green-500', no: 'bg-red-500', info: 'bg-blue-400', todo: 'bg-amber-500' };
  function renderNotifList(seen) {
    var list = document.getElementById('notif-list'), items = buildNotifications();
    list.innerHTML = items.length ? items.map(function (n, i) {
      var when = n.time ? new Date(n.time).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
      return '<button type="button" data-notif="' + i + '" class="w-full text-left flex gap-3 px-4 py-3 hover:bg-slate-50">' +
        '<span class="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ' + (seen[n.key] ? 'bg-slate-300' : NOTIF_TONE[n.tone]) + '"></span>' +
        '<span class="min-w-0"><span class="block text-sm ' + (seen[n.key] ? 'text-slate-600' : 'text-slate-900 font-medium') + '">' + esc(n.text) + '</span>' +
        '<span class="block text-xs text-slate-400 mt-0.5">' + esc(when) + '</span></span></button>';
    }).join('') : '<p class="px-4 py-8 text-center text-sm text-slate-500">Belum ada pemberitahuan.</p>';
    list._items = items;
  }
  function updateNotifBell() {
    var badge = document.getElementById('bell-badge');
    if (!badge) return;
    var u = activeUser(), items = buildNotifications(), seen = loadSeen();
    var unread = items.filter(function (n) { return !seen[n.key]; }).length;
    badge.textContent = unread > 9 ? '9+' : String(unread);
    badge.classList.toggle('hidden', !unread);
    var who = u ? notifSeenKey() : '';
    var panelOpen = !document.getElementById('notif-panel').classList.contains('hidden');
    if (who === notifLastUser && notifLastCount >= 0 && unread > notifLastCount && !panelOpen) {
      toast('Ada pemberitahuan baru.');
      try { if (navigator.vibrate) navigator.vibrate(200); } catch (e) {}
    }
    notifLastUser = who; notifLastCount = unread;
    if (panelOpen) renderNotifList(seen);
  }
  function openNotifPanel() {
    var seen = loadSeen();
    renderNotifList(seen);
    document.getElementById('notif-panel').classList.remove('hidden');
    buildNotifications().forEach(function (n) { seen[n.key] = 1; });
    saveSeen(seen);
    var badge = document.getElementById('bell-badge');
    badge.classList.add('hidden'); notifLastCount = 0;
    try { history.pushState({ modal: 'notif', view: (history.state && history.state.view) || 'home' }, ''); } catch (e) {}
  }
  function closeNotifPanel(fromPop) {
    var el = document.getElementById('notif-panel');
    if (el && !el.classList.contains('hidden')) {
      el.classList.add('hidden');
      if (!fromPop && history.state && history.state.modal === 'notif') {
        try { history.back(); } catch (e) {}
      }
    }
  }
  document.getElementById('btn-bell').addEventListener('click', openNotifPanel);
  document.getElementById('notif-close').addEventListener('click', function () { closeNotifPanel(); });
  document.getElementById('notif-panel').addEventListener('click', function (e) {
    if (e.target === this) { closeNotifPanel(); return; }
    var b = e.target.closest('[data-notif]');
    if (!b) return;
    var n = (document.getElementById('notif-list')._items || [])[+b.dataset.notif];
    closeNotifPanel();
    if (n) showView(n.view);
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeNotifPanel(); });

  function renderAll() {
    updateNotifBell();
    renderAdmin();
    renderApprover();
    renderCorrespondence();
    renderEmployeeProfile();
    renderEmployeeHistory();
    hitungSaldoCuti();
    renderLeaveBalanceAdmin();
    renderLastRequestTimeline();
  }
  function safeRender() {
    try { renderAll(); } catch (e) { console.error('Render error:', e); }
  }

  /* ---------- Navigation ---------- */
  var navFromPop = false;
  function showView(v) {
    var user = activeUser();
    if (v !== 'home' && v !== 'login' && !user && !(v === 'profile-setup' && pendingProfileUser)) v = 'login';
    var roleView = user && { employee: 'employee', approver: 'approver', correspondence: 'correspondence', admin: 'admin' }[user.role];
    var allViews = ['employee', 'approver', 'correspondence', 'admin'];
    if (user && v === 'login') v = roleView || 'employee';
    if (isAdmin2()) {
      if (v !== 'home' && v !== 'login' && allViews.indexOf(v) === -1) v = roleView;
    } else if (roleView && v !== 'home' && v !== 'login' && v !== roleView && !(v === 'employee' && applicantProfile(user))) v = roleView;
    document.querySelectorAll('.view').forEach(function (s) { s.classList.toggle('active', s.id === 'view-' + v); });
    try {
      if (!navFromPop) {
        var curState = (history.state && history.state.view) || '';
        if (curState !== v) history.pushState({ view: v, sub: v === 'employee' ? 'menu' : '' }, '');
      }
    } catch (e) {}
    navFromPop = false;
    document.querySelectorAll('.nav-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.view === v);
      b.classList.toggle('hidden', !currentUser || (!isAdmin2() && b.dataset.view !== roleView && !(b.dataset.view === 'employee' && applicantProfile(user))));
    });
    document.querySelectorAll('.nav-btn').forEach(function (b) {
      if (b.dataset.view === 'approver') b.textContent = approverNameForUser(user) || 'Halaman Penyetuju';
      if (b.dataset.view === 'employee') b.textContent = (user && user.role !== 'employee' && !isAdmin2()) ? 'Pengajuan Cuti Saya' : 'Profil & Pengajuan';
      if (b.dataset.view === 'admin') b.textContent = user && user.role === 'admin' ? user.name : 'Admin';
    });
    document.getElementById('main-nav').classList.toggle('hidden', !currentUser);
    updateNotifBell();
    document.getElementById('btn-stop-test').classList.toggle('hidden', !testUser);
    var testBanner = document.getElementById('test-mode-banner');
    testBanner.classList.toggle('hidden', !testUser);
    testBanner.textContent = testUser
      ? 'MODE UJI LIVE sebagai ' + testUser.roleLabel + ' — ' + testUser.name + ' (' + testUser.nip + '). Perubahan tersimpan pada data bersama. Akhiri mode uji untuk kembali ke akun Admin 2.'
      : '';
    document.getElementById('data-tools').style.display = isAdmin1Or2() ? '' : 'none';
    document.getElementById('btn-all').classList.toggle('hidden', !canExportExcel());
    if (v === 'employee' && !navFromPop) empShow('menu', true);
    safeRender();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('.nav-btn, .go-btn');
    if (!b) return;
    var target = b.dataset.view;
    if (!target) return;
    var user = activeUser();
    if (target === 'home') {
      showView('home');
    } else if (b.classList.contains('go-btn') && user) {
      showView(user.role || 'employee');
    } else {
      showView(target);
    }
  });
  document.querySelectorAll('.collapsible-panel-toggle').forEach(function (toggle) {
    toggle.addEventListener('click', function () {
      var view = toggle.closest('.view');
      var opening = toggle.getAttribute('aria-expanded') !== 'true';
      view.querySelectorAll('.collapsible-panel-toggle').forEach(function (other) {
        other.setAttribute('aria-expanded', 'false');
        document.getElementById(other.getAttribute('aria-controls')).classList.add('hidden');
        other.querySelector('[data-approver-toggle-icon]').textContent = '+';
      });
      if (opening) {
        toggle.setAttribute('aria-expanded', 'true');
        document.getElementById(toggle.getAttribute('aria-controls')).classList.remove('hidden');
        toggle.querySelector('[data-approver-toggle-icon]').textContent = '−';
      }
    });
  });

  /* ---------- Form ---------- */
  /* ---------- Dokumen persyaratan (unggah berkas / ambil foto) untuk jenis cuti selain Tahunan ---------- */
  var ATTACH_REQS = {
    Besar: { label: 'Cuti Besar', text: 'Formulir, dan surat keterangan masa kerja minimal 5 tahun terus-menerus' },
    Sick: { label: 'Cuti Sakit', text: 'Surat keterangan dokter pemerintah / puskesmas / rumah sakit, wajib jika lebih dari 1 hari' },
    Melahirkan: { label: 'Cuti Melahirkan', text: 'Surat keterangan dokter / bidan tentang perkiraan kelahiran, dan surat keterangan kelahiran setelah melahirkan' },
    Personal: { label: 'Cuti Karena Alasan Penting', text: 'Tergantung alasan: surat kematian keluarga, surat keterangan sakit keras keluarga, undangan pernikahan, surat tugas bencana, dan dokumen pendukung lainnya' },
    LuarTanggungan: { label: 'Cuti Di Luar Tanggungan Negara', text: 'Formulir, SK CPNS/PNS, SK pangkat terakhir, dan surat pernyataan tidak terikat ikatan dinas' }
  };
  var ATTACH_MAX_FILES = 3, ATTACH_MAX_PDF = 500 * 1024, ATTACH_MAX_TOTAL = 600 * 1024, ATTACH_IMG_TARGET = 120 * 1024;
  var attachState = [];
  function attachBytes(a) { return Math.round(String(a.data || '').length * 0.75); }
  function attachSizeLabel(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  function renderAttachSection() {
    var wrap = document.getElementById('f-attach-wrap');
    if (!wrap) return;
    var type = document.getElementById('f-type').value, req = ATTACH_REQS[type];
    wrap.classList.toggle('hidden', !req);
    if (!req) return;
    document.getElementById('f-attach-type').textContent = '— ' + req.label;
    document.getElementById('f-attach-req').textContent = req.text;
    var list = document.getElementById('f-attach-list');
    list.innerHTML = attachState.map(function (a, i) {
      var thumb = a.type === 'image'
        ? '<img src="' + a.data + '" alt="" class="h-20 w-full rounded object-cover">'
        : '<div class="flex h-20 w-full items-center justify-center rounded bg-white text-3xl">📄</div>';
      return '<div class="rounded-lg border border-slate-200 bg-white p-2">' + thumb +
        '<div class="mt-1 truncate text-xs text-slate-700" title="' + esc(a.name) + '">' + esc(a.name) + '</div>' +
        '<div class="flex items-center justify-between text-xs text-slate-500"><span>' + attachSizeLabel(attachBytes(a)) + '</span>' +
        '<button type="button" data-attach-del="' + i + '" class="font-semibold text-red-600 hover:underline">Hapus</button></div></div>';
    }).join('');
  }
  function readAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(new Error('Gagal membaca berkas')); };
      fr.readAsDataURL(file);
    });
  }
  /* Foto dikecilkan bertahap (dimensi dan kualitas) sampai di bawah ATTACH_IMG_TARGET agar hemat penyimpanan */
  function compressImage(file) {
    return readAsDataUrl(file).then(function (src) {
      return new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () {
          var dim = Math.min(1000, Math.max(img.width, img.height)), quality = 0.6, out = '', tries = 0;
          do {
            var sc = Math.min(1, dim / Math.max(img.width, img.height));
            var c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(img.width * sc)); c.height = Math.max(1, Math.round(img.height * sc));
            var g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
            out = c.toDataURL('image/jpeg', quality);
            if (Math.round(out.length * 0.75) <= ATTACH_IMG_TARGET) break;
            if (quality > 0.4) quality -= 0.1; else dim = Math.round(dim * 0.8);
            tries++;
          } while (tries < 12 && dim > 400);
          resolve(out);
        };
        img.onerror = function () { reject(new Error('Gambar tidak dapat dibaca')); };
        img.src = src;
      });
    });
  }
  function addAttachmentFiles(files) {
    var arr = Array.prototype.slice.call(files || []);
    return arr.reduce(function (chain, file) {
      return chain.then(function () {
        if (attachState.length >= ATTACH_MAX_FILES) { toast('Maksimal ' + ATTACH_MAX_FILES + ' berkas.'); return; }
        var isImg = /^image\//.test(file.type), isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
        if (!isImg && !isPdf) { toast('Format ' + file.name + ' tidak didukung. Gunakan foto atau PDF.'); return; }
        if (isPdf && file.size > ATTACH_MAX_PDF) { toast('PDF ' + file.name + ' lebih dari 500 KB. Kecilkan ukuran PDF atau gunakan foto.'); return; }
        var job = isImg ? compressImage(file) : readAsDataUrl(file);
        return job.then(function (data) {
          var item = { name: isImg ? file.name.replace(/\.[^.]+$/, '') + '.jpg' : file.name, type: isImg ? 'image' : 'pdf', data: data };
          var total = attachState.reduce(function (n, a) { return n + attachBytes(a); }, 0) + attachBytes(item);
          if (total > ATTACH_MAX_TOTAL) { toast('Total ukuran lampiran melebihi 600 KB. Hapus berkas lain atau gunakan foto yang lebih kecil.'); return; }
          attachState.push(item);
        }).catch(function (err) { toast(err.message || 'Berkas gagal diproses.'); });
      });
    }, Promise.resolve()).then(renderAttachSection);
  }
  function attachmentProblem(data, attachments) {
    var req = ATTACH_REQS[data.type];
    if (!req) return '';
    var files = typeof attachments === 'undefined' ? attachState : attachments;
    if (files.length) return '';
    if (data.type === 'Sick' && hitungHariKerja(data.start, data.end) <= 1) return '';
    return 'Lengkapi dokumen persyaratan ' + req.label + ' (unggah berkas atau ambil foto): ' + req.text + '.';
  }
  (function initAttachUi() {
    var typeEl = document.getElementById('f-type');
    if (!typeEl) return;
    typeEl.addEventListener('change', renderAttachSection);
    ['f-attach-file', 'f-attach-photo'].forEach(function (id) {
      var inp = document.getElementById(id);
      inp.addEventListener('change', function () { var files = inp.files; addAttachmentFiles(files).then(function () { inp.value = ''; }); });
    });
    document.getElementById('f-attach-list').addEventListener('click', function (e) {
      var b = e.target.closest('[data-attach-del]');
      if (!b) return;
      attachState.splice(parseInt(b.getAttribute('data-attach-del'), 10), 1);
      renderAttachSection();
    });
    document.getElementById('leave-form').addEventListener('reset', function () { attachState = []; setTimeout(renderAttachSection, 0); });
    renderAttachSection();
  })();
  function openAttachModal(id) {
    var r = load().filter(function (x) { return x.id === id; })[0];
    var items = (r && r.attachments) || [];
    if (!items.length) { toast('Tidak ada lampiran pada pengajuan ini.'); return; }
    document.getElementById('attach-title').textContent = r.name + ' · ' + (TYPE_LABEL[r.type] || r.type);
    document.getElementById('attach-view').innerHTML = items.map(function (a) {
      var body = a.type === 'image'
        ? '<img src="' + a.data + '" alt="' + esc(a.name) + '" class="max-h-[60vh] w-full rounded-lg border border-slate-200 object-contain bg-slate-50">'
        : '<a href="' + a.data + '" download="' + esc(a.name) + '" class="inline-block rounded-lg border border-blue-300 bg-blue-50 px-4 py-2 text-sm font-semibold text-blue-800 hover:bg-blue-100">📄 Unduh / buka PDF</a>';
      return '<div><p class="mb-1 text-sm font-medium text-slate-700">' + esc(a.name) + '</p>' + body + '</div>';
    }).join('');
    var m = document.getElementById('attach-modal');
    m.classList.remove('hidden'); m.classList.add('flex');
  }
  (function initAttachModal() {
    var m = document.getElementById('attach-modal');
    if (!m) return;
    function close() { m.classList.add('hidden'); m.classList.remove('flex'); document.getElementById('attach-view').innerHTML = ''; }
    document.getElementById('attach-close').addEventListener('click', close);
    m.addEventListener('click', function (e) { if (e.target === m) close(); });
  })();

  var form = document.getElementById('leave-form');
  var errEl = document.getElementById('form-error');
  function showErr(m) { errEl.textContent = m; errEl.classList.remove('hidden'); }

  var editingDraftId = null;
  function collectFormData() { return { name: document.getElementById('f-name').value.trim(), type: document.getElementById('f-type').value, start: document.getElementById('f-start').value, end: document.getElementById('f-end').value, reason: document.getElementById('f-reason').value.trim(), alamat: document.getElementById('f-alamat').value.trim(), telp: document.getElementById('f-telp').value.trim(), atasanNip: document.getElementById('f-atasan-nip').value.trim() }; }
  function validIsoDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
    var date = new Date(value + 'T00:00:00');
    return !isNaN(date.getTime()) && date.getFullYear() + '-' +
      String(date.getMonth() + 1).padStart(2, '0') + '-' +
      String(date.getDate()).padStart(2, '0') === value;
  }
  function validateSubmission(prof, data, requireSig, signatureProvided, attachments) {
    if (!prof) return { ok: false, msg: 'Profil pegawai tidak ditemukan.' };
    if (!data.name || !data.start || !data.end || !data.reason) {
      return { ok: false, msg: 'Nama, tanggal, dan alasan wajib diisi.' };
    }
    if (!validIsoDate(data.start) || !validIsoDate(data.end)) {
      return { ok: false, msg: 'Tanggal mulai dan selesai tidak valid.' };
    }
    if (data.end < data.start) {
      return { ok: false, msg: 'Tanggal selesai tidak boleh sebelum tanggal mulai.' };
    }
    if (!hitungHariKerja(data.start, data.end)) {
      return { ok: false, msg: 'Rentang tanggal harus memuat minimal satu hari kerja.' };
    }
    if (requireSig) {
      if (!signatureProvided) return { ok: false, msg: 'Tanda tangan wajib diisi.' };
      var attProblem = attachmentProblem(data, attachments);
      if (attProblem) return { ok: false, msg: attProblem };
    }
    var route = resolveRoute(prof);
    if (!route.first) return { ok: false, msg: 'Rute persetujuan belum diatur.' };
    return { ok: true, prof: prof, data: data, route: route };
  }
  function validateForm(requireSig) {
    var user = activeUser();
    var prof = testUser ? (document.getElementById('f-nip').value ? testApplicant : null) : applicantProfile(user);
    if (testUser && !prof) return { ok: false, msg: 'Mode uji: ketik 3 huruf nama atau NIP pegawai, lalu pilih dari saran.', prof: null };
    if (!user || !prof) return { ok: false, msg: 'Silakan masuk dengan akun yang terdaftar.', prof: null, needLogin: true };
    if (!document.getElementById('f-nip').value) return { ok: false, msg: 'Ketik minimal 3 huruf nama atau NIP Anda.', prof: prof };
    var result = validateSubmission(prof, collectFormData(), requireSig, inked, attachState);
    result.needLogin = false;
    return result;
  }
  function buildRequestObject(prof, data, route, status) { var draftIdEl = document.getElementById('f-draft-id'); var id = (draftIdEl && draftIdEl.value) ? draftIdEl.value : ('r' + Date.now() + Math.floor(Math.random() * 1000)); return { id: id, name: prof.n, type: data.type, start: data.start, end: data.end, reason: data.reason, nip: prof.nip, masa: masaKerja(prof.nip), jabatan: prof.j, alamat: data.alamat, telp: data.telp, atasan: route.first, atasanNip: data.atasanNip, sig: cv.toDataURL('image/png'), signatureProvided: inked, unit: prof.unit, unitCode: prof.unitCode, firstApprover: route.first, firstApproverPosition: route.firstPosition, secondApprover: route.second, secondApproverPosition: route.secondPosition, status: status, createdAt: Date.now(), updatedAt: Date.now(), requestedBy: prof.nip, attachments: ATTACH_REQS[data.type] ? attachState.slice() : [] }; }
  function saveAsDraft() { var errEl = document.getElementById('form-error'); errEl.classList.add('hidden'); var user = activeUser(); var prof = testUser ? (document.getElementById('f-nip').value ? testApplicant : null) : applicantProfile(user); if (!user || !prof) { errEl.textContent = 'Silakan masuk terlebih dahulu.'; errEl.classList.remove('hidden'); return; } var data = collectFormData(); if (!data.start || !data.end) { errEl.textContent = 'Tanggal mulai dan selesai wajib diisi untuk draft.'; errEl.classList.remove('hidden'); return; } var route = resolveRoute(prof); var list = load(); var draftIdEl = document.getElementById('f-draft-id'); var existingId = draftIdEl ? draftIdEl.value : null; var newReq = buildRequestObject(prof, data, route, 'draft'); if (existingId) { var found=false; list = list.map(function(r){ if (r.id === existingId) { found=true; newReq.createdAt = r.createdAt; return newReq; } return r; }); if (!found) list.push(newReq); } else { list.push(newReq); } if (!save(list)) return; form.reset(); clearSig(); if (draftIdEl) draftIdEl.value=''; editingDraftId=null; fillApplicant(); renderAll(); toast('Draft berhasil disimpan.'); showView('employee'); empShow('history'); }
  form.addEventListener('submit', function (e) { e.preventDefault(); var errEl = document.getElementById('form-error'); errEl.classList.add('hidden'); var vres = validateForm(true); if (!vres.ok) { errEl.textContent = vres.msg; errEl.classList.remove('hidden'); if (vres.needLogin) showView(vres.prof ? 'employee' : 'login'); return; } var prof = vres.prof, data = vres.data, route = vres.route; var list = load(); var draftIdEl = document.getElementById('f-draft-id'); var existingId = draftIdEl ? draftIdEl.value : null; var newReq = buildRequestObject(prof, data, route, 'pending_direct'); if (existingId) { list = list.map(function(r){ if (r.id === existingId) { newReq.createdAt = r.createdAt; return newReq; } return r; }); } else { list.push(newReq); } if (!save(list)) return; form.reset(); clearSig(); fillApplicant(); if (draftIdEl) draftIdEl.value=''; editingDraftId=null; renderAll(); toast('Pengajuan terkirim kepada ' + (route.first || 'penyetuju tahap 1') + '.'); notifyByNip(nipFromName(route.first, APPROVERS), 'Pengajuan cuti baru', prof.n + ' mengajukan cuti ' + (TYPE_LABEL[data.type] || data.type) + ' menunggu persetujuan Anda (Tahap 1).'); showView('employee'); empShow('history'); });
  var draftBtn = document.getElementById('btn-save-draft'); if (draftBtn) draftBtn.addEventListener('click', function(){ saveAsDraft(); });
  window.editDraft = function(id) { var r = load().filter(function(x){ return x.id === id && x.status === 'draft'; })[0]; if (!r) { toast('Draft tidak ditemukan.'); return; } showView('employee'); empShow('form'); setTimeout(function(){ document.getElementById('f-name').value = r.name || ''; document.getElementById('f-nip').value = r.nip || ''; document.getElementById('f-jab').value = r.jabatan || ''; document.getElementById('f-masa').value = r.masa || ''; document.getElementById('f-type').value = r.type || 'Annual'; document.getElementById('f-start').value = r.start || ''; document.getElementById('f-end').value = r.end || ''; document.getElementById('f-reason').value = r.reason || ''; document.getElementById('f-alamat').value = r.alamat || ''; document.getElementById('f-telp').value = r.telp || ''; document.getElementById('f-atasan').value = r.firstApprover || ''; document.getElementById('f-atasan-nip').value = r.atasanNip || ''; var draftIdEl = document.getElementById('f-draft-id'); if (draftIdEl) draftIdEl.value = r.id; editingDraftId = r.id; attachState = (r.attachments || []).slice(); renderAttachSection(); if (typeof updateHariKerjaInfo === 'function') updateHariKerjaInfo(); if (typeof updateRuleWarning === 'function') updateRuleWarning(); toast('Draft dimuat.'); },200); };
  window.sendDraft = function(id) {
    var list = load();
    var request = list.filter(function (item) { return item.id === id && item.status === 'draft'; })[0];
    if (!request) { toast('Draft tidak ditemukan.'); return; }
    var user = activeUser();
    var prof = testUser && testApplicant ? testApplicant : applicantProfile(user);
    if (!user || !prof || nipKey(request.requestedBy || request.nip) !== nipKey(prof.nip)) {
      toast('Draft ini bukan milik akun yang sedang masuk.');
      return;
    }
    if (!request.signatureProvided) {
      toast('Tanda tangan belum tercatat pada draft. Edit draft, bubuhkan tanda tangan, lalu simpan kembali.');
      return;
    }
    var result = validateSubmission(prof, request, true, !!request.signatureProvided, request.attachments || []);
    if (!result.ok) {
      toast('Draft belum dapat dikirim: ' + result.msg);
      return;
    }
    if (!confirm('Kirim draft ini menjadi pengajuan resmi?')) return;
    request.name = prof.n;
    request.nip = prof.nip;
    request.requestedBy = prof.nip;
    request.jabatan = prof.j;
    request.masa = masaKerja(prof.nip);
    request.unit = prof.unit;
    request.unitCode = prof.unitCode;
    request.firstApprover = result.route.first;
    request.firstApproverPosition = result.route.firstPosition;
    request.secondApprover = result.route.second;
    request.secondApproverPosition = result.route.secondPosition;
    request.atasan = result.route.first;
    request.status = 'pending_direct';
    request.createdAt = Date.now();
    request.updatedAt = Date.now();
    if (!save(list)) return;
    requestWriteQueue.then(function (saved) {
      if (!saved) {
        loadRequestsFromServer();
        return;
      }
      renderAll();
      toast('Draft berhasil dikirim kepada ' + result.route.first + '.');
      notifyByNip(nipFromName(result.route.first, APPROVERS), 'Pengajuan cuti baru (dari draft)',
        prof.n + ' mengajukan cuti ' + (TYPE_LABEL[request.type] || request.type));
    });
  };


/* ---------- Data pegawai & autofill ---------- */
  var HEAD = {
    K: ['', ''], B: ['', ''], H: ['', ''], L: ['', ''], A: ['', ''], R: ['', ''],
    P: ['', ''], M: ['', ''], S: ['', ''], E: ['', ''], T: ['', ''], I: ['', '']
  };
  var UP = { S: 'B', E: 'B', T: 'B', I: 'K', P: 'H', M: 'H', R: 'L', A: 'L', H: 'K', L: 'K', B: 'K' };
  var JC = { a: 'Penelaah Teknis Kebijakan', b: 'Petugas Telkompel', c: 'Penguji Peralatan Keselamatan Pelayaran', d: 'Teknisi Menara Suar (TMS)',
    e: 'Pengawas Keselamatan Pelayaran Penyelia', f: 'Pengawas Sarana dan Prasarana Kenavigasian', g: 'Penilik Kenavigasian',
    h: 'Surveyor Kenavigasian', i: 'Operator VTS', j: 'Penjaga Menara Suar' };
  var EMP = [];
  var UNIT_LABEL = {
    S: 'SUBBAGIAN SDM DAN UMUM',
    T: 'UNIT PENGEMBANGAN USAHA',
    E: 'SUBBAGIAN PERENCANAAN DAN KEUANGAN',
    I: 'SATUAN PEMERIKSAAN INTERN',
    P: 'SEKSI LAYANAN ALUR PELAYARAN',
    M: 'SEKSI LAYANAN TELKOMPEL',
    R: 'SEKSI LAYANAN SBNP',
    A: 'SEKSI LAYANAN ARMADA',
    B: 'BAGIAN KEUANGAN DAN UMUM',
    H: 'BIDANG LAYANAN ALUR PELAYARAN DAN TELKOMPEL',
    L: 'BIDANG LAYANAN SBNP DAN ARMADA',
    K: 'DISTRIK NAVIGASI TIPE B TANJUNG PRIOK'
  };
  function unitCodeFor(nip, groupCode) {
    for (var code in HEAD) if (HEAD[code][1] === nip) return code;
    return groupCode;
  }
  function resolveRoute(employee) {
    var code = employee.unitCode, head = HEAD[code] || ['', ''], first = '', second = '';
    if (employee.nip === '19750904 199703 1 001') {
      return {
        first: HEAD.K[0],
        second: '',
        firstPosition: positionForApprover(HEAD.K[0]),
        secondPosition: ''
      };
    }
    if (/^Nakhoda Kapal/i.test(employee.j)) return { first: HEAD.K[0], second: '' };
    /* Manager VTS / Manager SROP: penyetuju 1 = Kepala Seksi sesuai seksinya (bila kosong, naik ke Kepala Bidang), penyetuju 2 = Kepala Distrik */
    if (/^(?:Manager\s+(?:VTS|SROP)|Kasrop)\b/i.test(employee.j || '')) {
      var mgrFirst = (head && head[0]) ? head[0] : ((UP[code] && HEAD[UP[code]]) ? HEAD[UP[code]][0] : '');
      return {
        first: mgrFirst,
        second: HEAD.K[0],
        firstPosition: positionForApprover(mgrFirst),
        secondPosition: positionForApprover(HEAD.K[0])
      };
    }
    if (employee.nip === HEAD.K[1]) return { first: '', second: '' };
    if (employee.nip === HEAD.B[1] || employee.nip === HEAD.H[1] || employee.nip === HEAD.L[1] ||
      employee.nip === HEAD.T[1] || employee.nip === HEAD.I[1]) {
      first = HEAD.K[0];
    } else if (code === 'S' || code === 'E') {
      first = employee.nip === head[1] ? HEAD.B[0] : head[0];
      second = employee.nip === head[1] ? HEAD.K[0] : HEAD.B[0];
    } else if (code === 'T' || code === 'I') {
      first = head[0];
      second = HEAD.K[0];
    } else if (code === 'P' || code === 'M') {
      /* Pegawai seksi: P1 = Kepala Seksi (bila kosong, naik ke Kepala Bidang), P2 = Kepala Bagian Keuangan dan Umum.
         Kepala Seksi: P1 = Kepala Bidang, P2 = Kepala Distrik. */
      if (employee.nip === head[1]) { first = HEAD.H[0]; second = HEAD.K[0]; }
      else { first = head[0] || HEAD.H[0]; second = HEAD.B[0]; }
    } else if (code === 'R' || code === 'A') {
      if (employee.nip === head[1]) { first = HEAD.L[0]; second = HEAD.K[0]; }
      else { first = head[0] || HEAD.L[0]; second = HEAD.B[0]; }
    } else if (code === 'B' || code === 'H' || code === 'L') {
      first = head[0];
      second = HEAD.K[0];
    } else {
      first = employee.an || '';
    }
    return {
      first: first,
      second: second,
      firstPosition: positionForApprover(first),
      secondPosition: positionForApprover(second)
    };
  }
  function positionForApprover(name) {
    var person = EMP.filter(function (e) { return e.n === name; })[0];
    return person ? person.j : '';
  }
  var APPROVERS = [];
  var ADMINS = [];
  var CORRESPONDENCE = [];
  var additionalApprovers = [];
  var additionalAdmins = [];
  var additionalCorrespondence = [];
  var directoryLoaded = false;
  var directoryLoading = null;
  function loadDirectoryFromServer() {
    if (!supabaseClient) return Promise.reject(new Error(supabaseInitError || 'Supabase tidak tersedia.'));
    if (directoryLoaded) return Promise.resolve(EMP);
    if (directoryLoading) return directoryLoading;
    directoryLoading = Promise.all([
      supabaseClient.from('employees').select('nip,name,jabatan,unit_code,atasan_code').order('nip'),
      supabaseClient.from('staff_members').select('nip,role,name,title,sort').order('sort'),
      supabaseClient.from('unit_heads').select('code,nip,name')
    ]).then(function (results) {
      results.forEach(function (result) { if (result.error) throw result.error; });
      var employees = results[0].data || [];
      var staff = results[1].data || [];
      var heads = results[2].data || [];
      HEAD = {
        K: ['', ''], B: ['', ''], H: ['', ''], L: ['', ''], A: ['', ''], R: ['', ''],
        P: ['', ''], M: ['', ''], S: ['', ''], E: ['', ''], T: ['', ''], I: ['', '']
      };
      heads.forEach(function (row) { HEAD[row.code] = [row.name || '', row.nip || '']; });
      EMP.length = 0;
      employees.forEach(function (row) {
        var head = HEAD[row.atasan_code] || ['', ''];
        EMP.push({
          n: row.name,
          nip: row.nip,
          j: row.jabatan || '',
          an: head[0],
          anip: head[1],
          unitCode: row.unit_code,
          unit: UNIT_LABEL[row.unit_code] || row.unit_code || '',
          atasanCode: row.atasan_code,
          origNip: row.nip
        });
      });
      APPROVERS.length = 0;
      ADMINS.length = 0;
      CORRESPONDENCE.length = 0;
      additionalApprovers.length = 0;
      additionalAdmins.length = 0;
      additionalCorrespondence.length = 0;
      staff.forEach(function (row) {
        var person = { name: row.name, nip: row.nip, title: row.title || '', sort: row.sort };
        if (row.role === 'approver') {
          APPROVERS.push(person);
          if (row.sort > 11) additionalApprovers.push(person);
        } else if (row.role === 'admin') {
          ADMINS.push(person);
          if (row.sort > 2) additionalAdmins.push(person);
        } else if (row.role === 'correspondence') {
          CORRESPONDENCE.push(person);
          if (row.sort > 5) additionalCorrespondence.push(person);
        }
      });
      BASE_EMP = EMP.map(function (person) { return Object.assign({}, person); });
      directoryLoaded = true;
      return EMP;
    }).catch(function (error) {
      console.error('Direktori pegawai gagal dimuat dari Supabase:', error);
      throw error;
    }).then(function (result) {
      directoryLoading = null;
      return result;
    }, function (error) {
      directoryLoading = null;
      throw error;
    });
    return directoryLoading;
  }

  var SOCIAL_LINKS_KEY = 'cuti_social_links_v1';
  var SOCIAL_SITES = [
    { id: 'youtube', label: 'YouTube', color: 'text-red-600', icon: '<svg aria-hidden="true" viewBox="0 0 24 24" class="h-5 w-5" fill="currentColor"><path d="M23 7.2a3 3 0 0 0-2.1-2.1C19 4.6 12 4.6 12 4.6s-7 0-8.9.5A3 3 0 0 0 1 7.2C.5 9.1.5 12 .5 12s0 2.9.5 4.8a3 3 0 0 0 2.1 2.1c1.9.5 8.9.5 8.9.5s7 0 8.9-.5a3 3 0 0 0 2.1-2.1c.5-1.9.5-4.8.5-4.8s0-2.9-.5-4.8Z"/><path d="m9.7 15.5 5.8-3.5-5.8-3.5v7Z" fill="#ffffff"/></svg>' },
    { id: 'facebook', label: 'Facebook', color: 'text-blue-600', icon: '<svg aria-hidden="true" viewBox="0 0 24 24" class="h-5 w-5" fill="currentColor"><path d="M13.5 21v-8h2.7l.4-3.1h-3.1v-2c0-.9.3-1.5 1.6-1.5h1.7V3.6c-.3 0-1.3-.1-2.5-.1-2.5 0-4.2 1.5-4.2 4.3v2.1H7.3V13h2.8v8h3.4Z"/></svg>' },
    { id: 'instagram', label: 'Instagram', color: 'text-pink-600', icon: '<svg aria-hidden="true" viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="18" cy="6" r=".8" fill="currentColor" stroke="none"/></svg>' },
    { id: 'x', label: 'X', color: 'text-slate-900', icon: '<svg aria-hidden="true" viewBox="0 0 24 24" class="h-5 w-5" fill="currentColor"><path d="M18.9 2H22l-6.8 7.8L23.2 22h-6.3l-4.9-7.4L5.5 22H2.3l7.3-8.4L1.8 2h6.5l4.4 6.8L18.9 2Zm-1.1 18h1.7L7.3 3.9H5.5L17.8 20Z"/></svg>' },
    { id: 'tiktok', label: 'TikTok', color: 'text-slate-900', icon: '<svg aria-hidden="true" viewBox="0 0 24 24" class="h-5 w-5" fill="currentColor"><path d="M16.5 3c.4 2.2 1.7 3.6 4 3.8v3.4c-1.5 0-2.8-.5-4-1.3v6.5a6.3 6.3 0 1 1-6.3-6.3c.4 0 .8 0 1.2.1v3.5a2.8 2.8 0 1 0 1.8 2.7V3h3.3Z"/></svg>' },
    { id: 'threads', label: 'Threads', color: 'text-slate-900', icon: '<svg aria-hidden="true" viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><path d="M19.2 11.4c-.4-5.2-3-8-7.2-8-4.5 0-7.4 3.1-7.4 8.5 0 5.2 2.7 8.7 7.2 8.7 3.6 0 6-2 6-5.1 0-2.5-1.6-4-4.1-4-2 0-3.3 1-3.3 2.6 0 1.3 1 2.2 2.4 2.2 1.8 0 3.1-1.5 3.5-4.2"/></svg>' },
    { id: 'whatsapp', label: 'WhatsApp', color: 'text-green-600', icon: '<svg aria-hidden="true" viewBox="0 0 24 24" class="h-5 w-5" fill="currentColor"><path d="M12 2a9.8 9.8 0 0 0-8.4 14.8L2.3 22l5.4-1.4A9.8 9.8 0 1 0 12 2Zm0 17.8a8 8 0 0 1-4.1-1.1l-.3-.2-3.2.8.9-3.1-.2-.3A8 8 0 1 1 12 19.8Zm4.4-6c-.2-.1-1.5-.7-1.7-.7s-.4-.1-.5.1-.6.7-.7.8-.2.2-.4.1a6.5 6.5 0 0 1-1.9-1.2 7 7 0 0 1-1.3-1.6c-.1-.2 0-.3.1-.4l.3-.4.2-.3c.1-.1 0-.3 0-.4s-.5-1.2-.7-1.6c-.2-.4-.4-.3-.5-.3h-.4c-.1 0-.4 0-.6.3s-.8.8-.8 1.9.8 2.2.9 2.4a9 9 0 0 0 3.5 3.1c.5.2.9.4 1.2.5.5.2 1 .2 1.4.1.4-.1 1.5-.6 1.7-1.1s.2-1 .2-1.1-.1-.2-.3-.3Z"/></svg>' }
  ];
  function normalizeSocialUrl(value) {
    if (!value) return '';
    try {
      var url = new URL(String(value).trim());
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
    } catch (error) {
      return '';
    }
  }
  function loadSocialLinks() {
    try {
      var saved = JSON.parse(localStorage.getItem(SOCIAL_LINKS_KEY)) || {};
      return SOCIAL_SITES.reduce(function (links, site) {
        links[site.id] = normalizeSocialUrl(saved[site.id]);
        return links;
      }, {});
    } catch (error) {
      console.error('Tautan media sosial tidak dapat dibaca:', error);
      return {};
    }
  }
  var socialLinks = loadSocialLinks();
  function renderSocialLinks() {
    var container = document.getElementById('home-social-links');
    if (!container) return;
    var logo = container.parentElement.querySelector('img');
    function alignWithLogo() {
      if (!logo) return;
      var lw = logo.getBoundingClientRect().width;
      var width = Math.max(lw, 240) + 'px';
      container.style.width = width;
      var cutiLogo = document.getElementById('home-cuti-logo');
      if (cutiLogo) cutiLogo.style.width = width;
    }
    alignWithLogo();
    container.innerHTML = SOCIAL_SITES.map(function (site) {
      var url = socialLinks[site.id];
      var iconClass = 'social-link-icon inline-flex h-11 w-11 items-center justify-center rounded-xl border border-white/80 bg-white shadow-md ' + site.color;
      if (url) return '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" class="' + iconClass + '" aria-label="' + site.label + '" title="' + site.label + '">' + site.icon + '</a>';
      return '<span class="' + iconClass + '" aria-disabled="true" aria-label="' + site.label + ', tautan belum diatur" title="' + site.label + ': tautan belum diatur">' + site.icon + '</span>';
    }).join('');
    if (logo && !logo.dataset.socialResizeBound) {
      logo.dataset.socialResizeBound = '1';
      logo.addEventListener('load', alignWithLogo);
      window.addEventListener('resize', alignWithLogo);
    }
  }
  function fillSocialLinkInputs() {
    SOCIAL_SITES.forEach(function (site) {
      var input = document.getElementById('admin2-social-' + site.id);
      if (input) input.value = socialLinks[site.id] || '';
    });
  }
  /* Muat tautan media sosial dari server untuk SEMUA pengunjung (tanpa login).
     Hanya membaca; tidak pernah menulis balik ke server. */
  function loadSocialLinksFromServer() {
    if (!supabaseClient) return Promise.resolve();
    return supabaseClient.from('app_settings').select('value').eq('key', 'social_links').maybeSingle()
      .then(function (result) {
        if (result.error) throw result.error;
        var serverLinks = (result.data && result.data.value) || {};
        socialLinks = SOCIAL_SITES.reduce(function (links, site) {
          links[site.id] = normalizeSocialUrl(serverLinks[site.id]);
          return links;
        }, {});
        try { localStorage.setItem(SOCIAL_LINKS_KEY, JSON.stringify(socialLinks)); } catch (e) {}
        /* Pulihkan sesi lokal agar user tetap bisa keluar-masuk Beranda tanpa login ulang */
  try {
    var cached = restoreSessionUser();
    if (cached && !currentUser) {
      currentUser = cached;
    }
  } catch(e){}

  renderSocialLinks();
        fillSocialLinkInputs();
      })
      .catch(function (error) {
        console.error('Tautan media sosial gagal dimuat dari server:', error);
      });
  }
  function staffAccountByEmail(email) {
    var normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail) return null;
    var accounts = [];
    ADMINS.forEach(function (person) { if (person.email) accounts.push({ role: 'admin', person: person }); });
    CORRESPONDENCE.forEach(function (person) { if (person.email) accounts.push({ role: 'correspondence', person: person }); });
    return accounts.filter(function (account) {
      return account.person.email.trim().toLowerCase() === normalizedEmail;
    })[0] || null;
  }
  /* Penyetuju, Admin, dan Persuratan dikenali dari NIP (metadata akun), bukan email. */
  function staffAccountByNip(nip) {
    var key = String(nip || '').replace(/\s/g, '');
    if (!key) return null;
    var groups = [
      { role: 'admin', list: ADMINS },
      { role: 'correspondence', list: CORRESPONDENCE },
      { role: 'approver', list: APPROVERS }
    ];
    for (var i = 0; i < groups.length; i++) {
      var person = groups[i].list.filter(function (p) { return p.nip.replace(/\s/g, '') === key; })[0];
      if (person) return { role: groups[i].role, person: person };
    }
    return null;
  }
  function staffEmailAlreadyAssigned(email, nip) {
    var normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail) return false;
    var lists = [APPROVERS, ADMINS, CORRESPONDENCE];
    return lists.some(function (list) {
      return list.some(function (person) {
        return person.nip !== nip && person.email && person.email.trim().toLowerCase() === normalizedEmail;
      });
    });
  }
  function updateApproverNameReferences(oldName, newName, oldNip, newNip) {
    var nipChanged = oldNip !== newNip;
    Object.keys(HEAD).forEach(function (code) {
      if (HEAD[code][1] === oldNip) { HEAD[code][0] = newName; if (nipChanged) HEAD[code][1] = newNip; }
    });
    EMP.forEach(function (person) {
      if (person.nip === oldNip) { person.n = newName; if (nipChanged) person.nip = newNip; }
      if (person.an === oldName) person.an = newName;
      if (nipChanged && person.anip === oldNip) person.anip = newNip;
    });
    var requests = load();
    var changed = false;
    requests.forEach(function (request) {
      if (request.status !== 'pending_direct' && request.status !== 'pending_next') return;
      if (request.firstApprover === oldName) { request.firstApprover = newName; changed = true; }
      if (request.secondApprover === oldName) { request.secondApprover = newName; changed = true; }
    });
    return !changed || save(requests);
  }
  function approverByNip(nip) {
    return APPROVERS.filter(function (person) { return person.nip === nip; })[0] || null;
  }
  function approverNameForUser(user) {
    var person = user && user.role === 'approver' ? approverByNip(user.nip) : null;
    return person ? person.name : '';
  }
  function findStaffByRoleAndNip(role, nip) {
    var key = String(nip || '').replace(/\s/g, '');
    var list = { approver: APPROVERS, correspondence: CORRESPONDENCE, admin: ADMINS }[role];
    if (!list || !key) return null;
    return list.filter(function (p) { return p.nip.replace(/\s/g, '') === key; })[0] || null;
  }
  function renderAdmin2ApproverManagement() {
    var panel = document.getElementById('admin2-approver-management');
    var isAdmin2 = canManageAdmin2Settings();
    panel.classList.toggle('hidden', !isAdmin2);
    if (!isAdmin2) return;
    var roles = [
      { key: 'approver', label: 'Penyetuju', list: APPROVERS, additions: additionalApprovers },
      { key: 'correspondence', label: 'Persuratan', list: CORRESPONDENCE, additions: additionalCorrespondence },
      { key: 'admin', label: 'Admin', list: ADMINS, additions: additionalAdmins }
    ];
    var html = roles.map(function (role) {
      var rows = role.list.map(function (person) {
        var isAdditional = role.additions.some(function (a) {
          return a.nip.replace(/\s/g, '') === person.nip.replace(/\s/g, '');
        });
        var deleteBtn = isAdditional
          ? '<button type="button" data-action="delete-staff" data-role="' + role.key + '" data-nip="' + esc(person.nip) + '" class="px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-50 text-red-700 border border-red-200 hover:bg-red-100">Hapus</button>'
          : '<span class="text-xs text-slate-400">data bawaan</span>';
        return [
          '<input type="text" class="staff-name inp min-w-56" data-role="' + role.key + '" data-nip="' + esc(person.nip) + '" value="' + esc(person.name) + '" required><div class="text-xs text-slate-500 mt-1">' + esc(person.title) + (person.email ? ' · ' + esc(person.email) : '') + '</div>',
          '<input type="text" class="staff-nip inp min-w-44" data-role="' + role.key + '" data-nip="' + esc(person.nip) + '" value="' + esc(person.nip) + '" required>',
          '<div class="flex flex-wrap gap-2">' +
            '<button type="button" data-action="save-staff-name" data-role="' + role.key + '" data-nip="' + esc(person.nip) + '" class="px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-700 text-white hover:bg-blue-800">Ubah nama</button>' +
            deleteBtn +
          '</div>'
        ];
      });
      return '<h4 class="font-semibold text-blue-900 mt-5 mb-2">' + role.label + ' <span class="text-sm font-normal text-slate-500">(' + role.list.length + ')</span></h4>' +
        table(['Nama', 'NIP', 'Aksi'], rows);
    }).join('');
    document.getElementById('admin2-approver-table').innerHTML = html;
  }
  function loadRegistrationRequests() {
    var section = document.getElementById('registration-requests-section');
    if (!section) return Promise.resolve();
    section.classList.toggle('hidden', !isAdmin1Or2());
    if (!isAdmin1Or2() || !supabaseClient) return Promise.resolve();
    return supabaseClient.from('registration_requests')
      .select('id,email,claimed_name,claimed_nip,created_at')
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .then(function (result) {
        if (result.error) throw result.error;
        var container = document.getElementById('registration-requests-list');
        var requests = result.data || [];
        if (!requests.length) {
          container.innerHTML = '<p class="text-sm text-slate-500">Tidak ada permintaan yang menunggu.</p>';
          return;
        }
        var seenNips = {}, identities = [];
        EMP.concat(APPROVERS, ADMINS, CORRESPONDENCE).forEach(function (person) {
          var key = nipKey(person.nip);
          if (!key || seenNips[key]) return;
          seenNips[key] = true;
          identities.push({ name: person.n || person.name, nip: person.nip });
        });
        var options = identities.map(function (identity) {
          return '<option value="' + esc(identity.nip) + '">' + esc(identity.name + ' — ' + identity.nip) + '</option>';
        }).join('');
        container.innerHTML = '<table class="min-w-full text-sm"><thead><tr class="text-left bg-slate-100">' +
          '<th class="p-2">Email</th><th class="p-2">Nama diajukan</th><th class="p-2">NIP diajukan</th>' +
          '<th class="p-2">Tautkan ke NIP</th><th class="p-2">Tanggal</th><th class="p-2">Aksi</th></tr></thead><tbody>' +
          requests.map(function (request) {
            var chosen = identities.filter(function (identity) { return nipKey(identity.nip) === nipKey(request.claimed_nip); })[0];
            var choices = '<option value="">Pilih pegawai...</option>' + options;
            var selectedChoices = chosen
              ? choices.replace('value="' + esc(chosen.nip) + '"', 'value="' + esc(chosen.nip) + '" selected')
              : choices;
            return '<tr class="border-t" data-registration-row="' + esc(request.id) + '">' +
              '<td class="p-2">' + esc(request.email) + '</td><td class="p-2">' + esc(request.claimed_name || '—') + '</td>' +
              '<td class="p-2">' + esc(request.claimed_nip || '—') + '</td>' +
              '<td class="p-2"><select class="registration-nip inp min-w-56">' + selectedChoices + '</select></td>' +
              '<td class="p-2 whitespace-nowrap">' + esc(new Date(request.created_at).toLocaleString('id-ID')) + '</td>' +
              '<td class="p-2 whitespace-nowrap"><button type="button" data-action="approve-registration" class="mr-2 rounded bg-green-700 px-3 py-1.5 text-xs font-semibold text-white">Setujui</button>' +
              '<button type="button" data-action="reject-registration" class="rounded bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700">Tolak</button></td></tr>';
          }).join('') + '</tbody></table>';
      }).catch(function (error) {
        console.error('Permintaan penautan akun gagal dimuat:', error);
        document.getElementById('registration-requests-list').textContent =
          'Permintaan gagal dimuat (' + (error.code || error.message || 'error') + ').';
      });
  }
  document.getElementById('registration-requests-refresh').addEventListener('click', loadRegistrationRequests);
  document.getElementById('registration-requests-list').addEventListener('click', function (event) {
    var button = event.target.closest('[data-action="approve-registration"], [data-action="reject-registration"]');
    if (!button || !isAdmin1Or2()) return;
    var row = button.closest('[data-registration-row]');
    var requestId = row && row.dataset.registrationRow;
    if (!requestId) return;
    var approve = button.dataset.action === 'approve-registration';
    var selectedNip = approve ? row.querySelector('.registration-nip').value : '';
    if (approve && !selectedNip) { toast('Pilih NIP pegawai sebelum menyetujui.'); return; }
    if (!confirm(approve
      ? 'Tautkan akun ini ke NIP ' + selectedNip + '? Pastikan email dan identitas pemohon sudah diverifikasi.'
      : 'Tolak permintaan penautan akun ini?')) return;
    var action = approve
      ? supabaseClient.rpc('admin_approve_registration', { p_request: requestId, p_nip: selectedNip })
      : supabaseClient.rpc('admin_reject_registration', { p_request: requestId });
    action.then(function (result) {
      if (result.error) throw result.error;
      toast(approve ? 'Akun berhasil ditautkan.' : 'Permintaan ditolak.');
      return loadRegistrationRequests();
    }).catch(function (error) {
      console.error('Keputusan permintaan penautan gagal:', error);
      toast('Permintaan gagal diproses (' + (error.code || error.message || 'error') + ').');
    });
  });
  /* Bagian Admin 2 bisa di-minimize; keadaan terakhir diingat di perangkat ini. */
  document.querySelectorAll('details.adm-sec').forEach(function (d) {
    var k = 'adm2_sec_' + d.dataset.sec;
    try { if (localStorage.getItem(k) === '1') d.open = true; } catch (e) {}
    d.addEventListener('toggle', function () { try { localStorage.setItem(k, d.open ? '1' : '0'); } catch (e) {} });
  });
  var addStaffPanel = document.getElementById('admin2-add-staff-panel');
  var addStaffForm = document.getElementById('admin2-add-staff-form');
  var addStaffError = document.getElementById('admin2-add-staff-error');
  var addStaffRole = '';
  /* ---------- Pengaturan bersama di Supabase (tabel app_settings) ---------- */
  function pushSetting(key, value) {
    if (!supabaseClient) return Promise.resolve(false);
    return supabaseClient.from('app_settings').upsert({ key: key, value: value, updated_at: new Date().toISOString() })
      .then(function (r) { if (r.error) throw r.error; return true; })
      .catch(function (error) {
        console.error('Pengaturan gagal disimpan ke server:', key, error);
        toast('Pengaturan gagal disimpan ke server (' + (error.code || error.message || 'error') + ').');
        return false;
      });
  }
  function cacheLocal(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {} }
  function cleanPerson(p) {
    if (!p || !p.name || !p.nip || !p.title) return null;
    var out = { name: String(p.name).trim(), nip: String(p.nip).trim(), title: String(p.title).trim() };
    if (p.email) out.email = String(p.email).trim();
    return out;
  }
  function samePerson(a, b) {
    return a.nip.replace(/\s/g, '') === b.nip.replace(/\s/g, '') || (!!a.email && !!b.email && a.email.toLowerCase() === b.email.toLowerCase());
  }
  /* ---------- Sisa cuti N, N-1, N-2 (diisi Admin 1, disimpan di tabel leave_balances) ---------- */
  var LEAVE_BAL_KEY = 'cuti_sisa_v2';
  var leaveBalances = (function () {
    try { var v = JSON.parse(localStorage.getItem(LEAVE_BAL_KEY) || '{}'); return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}; } catch (e) { return {}; }
  })();
  function nipKey(n) { return String(n || '').replace(/\s/g, ''); }
  function getLeaveBalance(nip) { return leaveBalances[nipKey(nip)] || null; }
  function cleanDays(v) { var n = parseInt(v, 10); return (isFinite(n) && n >= 0) ? Math.min(n, 999) : 0; }
  function activeBalanceTotal(balance) { return cleanDays(balance.n) + cleanDays(balance.n1) + cleanDays(balance.n2); }
  function allocateActiveBalanceTotal(balance, requestedTotal) {
    var target = Math.max(0, Math.min(parseInt(requestedTotal, 10) || 0, 2997));
    var current = activeBalanceTotal(balance), difference = target - current;
    if (difference > 0) {
      var add = Math.min(difference, 999 - cleanDays(balance.n));
      balance.n = cleanDays(balance.n) + add;
      difference -= add;
      add = Math.min(difference, 999 - cleanDays(balance.n1));
      balance.n1 = cleanDays(balance.n1) + add;
      difference -= add;
      add = Math.min(difference, 999 - cleanDays(balance.n2));
      balance.n2 = cleanDays(balance.n2) + add;
    } else if (difference < 0) {
      var remove = Math.min(-difference, cleanDays(balance.n));
      balance.n = cleanDays(balance.n) - remove;
      difference += remove;
      remove = Math.min(-difference, cleanDays(balance.n2));
      balance.n2 = cleanDays(balance.n2) - remove;
      difference += remove;
      remove = Math.min(-difference, cleanDays(balance.n1));
      balance.n1 = cleanDays(balance.n1) - remove;
    }
    return activeBalanceTotal(balance);
  }
  function cleanNote(v) { return String(v || '').trim().slice(0, 120); }
  function saveLeaveBalance(nip, entry) {
    if (!canExportExcel()) { toast('Hanya Admin 1 yang dapat mengisi sisa cuti.'); return Promise.resolve(false); }
    if (!supabaseClient) { toast('Server belum terhubung, sisa cuti tidak dapat disimpan.'); return Promise.resolve(false); }
    var key = nipKey(nip);
    return supabaseClient.from('leave_balances').upsert({ nip: key, data: entry, updated_at: new Date().toISOString() })
      .then(function (res) {
        if (res.error) throw res.error;
        leaveBalances[key] = entry;
        cacheLocal(LEAVE_BAL_KEY, leaveBalances);
        return true;
      })
      .catch(function (error) {
        console.error('Sisa cuti gagal disimpan:', error);
        toast('Sisa cuti gagal disimpan (' + (error.code || error.message || 'error') + '). Pastikan tabel leave_balances sudah dibuat dan akun Anda terdaftar sebagai Admin 1.');
        return false;
      });
  }
  function loadLeaveBalancesFromServer() {
    if (!supabaseClient) return Promise.resolve();
    return supabaseClient.rpc('rollover_leave_balances').then(function (rolloverResult) {
      if (rolloverResult.error) throw rolloverResult.error;
      return supabaseClient.from('leave_balances').select('nip,data');
    })
      .then(function (res) {
        if (res.error) throw res.error;
        var map = {};
        (res.data || []).forEach(function (row) { if (row && row.data) map[nipKey(row.nip)] = row.data; });
        leaveBalances = map;
        cacheLocal(LEAVE_BAL_KEY, map);
        return true;
      })
      .catch(function (error) {
        console.error('Sisa cuti gagal dimuat dari server:', error);
        return false;
      });
  }
  /* Sisa cuti efektif: nilai dasar (diisi Admin 1, bawaan N = 12 hari) dikurangi cuti tahunan yang sudah disetujui
     (dihitung hari kerja). Pemakaian dipotong dari N-2, lalu N-1, lalu N. Total sisa = N + N-1 + N-2.
     Pengajuan yang disetujui sebelum Admin 1 terakhir mengedit tidak dipotong lagi (sudah termasuk dalam angka editan). */
  var DEDUCT_STATUSES = ['pending_correspondence', 'pending_admin_issue', 'issued'];
  function approvalTime(r) { return r.secondApprovedAt || r.firstApprovedAt || r.updatedAt || r.createdAt || 0; }
  function effectiveBalance(nip, excludeId, reqs) {
    var key = nipKey(nip), stored = getLeaveBalance(nip), year = new Date().getFullYear();
    var base = stored
      ? { tahun: stored.tahun || year, n: stored.n || 0, n1: stored.n1 || 0, n2: stored.n2 || 0, since: stored.updatedAt || 0 }
      : { tahun: year, n: 12, n1: 0, n2: 0, since: 0 };
    var rem = [base.n2, base.n1, base.n];
    (reqs || load()).forEach(function (r) {
      if (excludeId && r.id === excludeId) return;
      var owner = nipKey(r.requestedBy || r.nip);
      if (owner !== key || r.type !== 'Annual' || DEDUCT_STATUSES.indexOf(r.status) === -1) return;
      if (!r.start || !r.end || new Date(r.start + 'T00:00:00').getFullYear() !== base.tahun) return;
      if (approvalTime(r) <= base.since) return;
      var d = hitungHariKerja(r.start, r.end);
      for (var i = 0; i < 3 && d > 0; i++) { var take = Math.min(rem[i], d); rem[i] -= take; d -= take; }
    });
    return Object.assign({}, stored || {}, { nip: nip, tahun: base.tahun, n2: rem[0], n1: rem[1], n: rem[2], isDefault: !stored });
  }
  /* Baris N-2, N-1, N untuk formulir Excel/PDF (sisa sebelum pengajuan ini) */
  function balanceForForm(nip, req) {
    var b = effectiveBalance(nip, req && req.id);
    var t = b.tahun;
    return {
      head: '1. CUTI TAHUNAN ' + t + ' (N=' + t + ', N-1=' + (t - 1) + ', N-2=' + (t - 2) + ')',
      rows: [
        { y: 'N-2 (' + (t - 2) + ')', s: String(b.n2), k: b.ket_n2 || '' },
        { y: 'N-1 (' + (t - 1) + ')', s: String(b.n1), k: b.ket_n1 || '' },
        { y: 'N (' + t + ')', s: String(b.n), k: b.ket_n || '' }
      ]
    };
  }
  function renderLeaveBalanceAdmin() {
    var sec = document.getElementById('admin-balance-section');
    if (!sec) return;
    sec.classList.toggle('hidden', !canExportExcel());
  }
  /* ---------- Nominatif pegawai: edit roster (nama, NIP, jabatan, unit, tambah, hapus) + sisa cuti massal (Admin 1) ---------- */
  var BASE_EMP = [];
  /* Admin 1 dan Admin 2 tidak boleh dihapus / diganti NIP-nya dari nominatif (akun login dan hak aksesnya terikat NIP). */
  function isProtectedNip(nip) {
    var k = nipKey(nip);
    return !!k && ADMINS.slice(0, 2).some(function (p) { return nipKey(p.nip) === k; });
  }
  (function initNominatif() {
    var openBtn = document.getElementById('btn-open-nominatif');
    var panel = document.getElementById('nominatif-panel');
    if (!openBtn || !panel) return;
    var tableEl = document.getElementById('nom-table');
    var countEl = document.getElementById('nom-count');
    var searchEl = document.getElementById('nom-search');
    var tahunEl = document.getElementById('nom-tahun');
    var nomReqs = null;
    var unitOptions = Object.keys(UNIT_LABEL).map(function (code) { return { code: code, label: UNIT_LABEL[code] }; });

    function unitSelect(selectedCode) {
      return '<select class="nom-unit rounded border border-slate-300 px-2 py-1 text-xs w-64">' + unitOptions.map(function (u) {
        return '<option value="' + u.code + '"' + (u.code === selectedCode ? ' selected' : '') + '>' + esc(u.label) + '</option>';
      }).join('') + '</select>';
    }
    function numInput(cls, val, editable) {
      var max = cls === 'nom-active' ? 2997 : 999;
      var balanceField = /^nom-(n2|n1|active|n)$/.test(cls);
      var locked = balanceField && !editable ? ' readonly aria-readonly="true" title="Klik Edit saldo untuk mengubah nilai"' : '';
      return '<input type="number" min="0" max="' + max + '" class="' + cls + ' w-16 rounded border border-slate-300 px-2 py-1 text-sm text-center' + (locked ? ' bg-slate-100' : '') + '"' + locked + ' value="' + esc(val === undefined || val === null ? '' : val) + '">';
    }
    function rowHtml(e, idx) {
      var b = effectiveBalance(e.nip, null, nomReqs);
      var orig = nipKey(e.origNip || e.nip), prot = isProtectedNip(e.nip);
      var isBase = BASE_EMP.some(function (x) { return nipKey(x.nip) === orig; });
      return '<tr class="nom-row border-t" data-nip="' + esc(e.nip) + '" data-orig="' + esc(orig) + '" data-base="' + (isBase ? '1' : '0') + '">' +
        '<td class="p-2 text-center text-slate-500 nom-no">' + idx + '</td>' +
        '<td class="p-2"><input type="text" class="nom-name w-56 rounded border border-slate-300 px-2 py-1 text-sm" value="' + esc(e.n) + '"></td>' +
        '<td class="p-2"><input type="text" class="nom-jab w-72 rounded border border-slate-300 px-2 py-1 text-xs" placeholder="Jabatan" value="' + esc(e.j || '') + '"></td>' +
        '<td class="p-2"><input type="text" class="nom-nipedit w-48 rounded border border-slate-300 px-2 py-1 text-xs"' + (prot ? ' readonly title="NIP Admin tidak dapat diubah dari nominatif" style="background:#f1f5f9"' : '') + ' value="' + esc(e.nip) + '"></td>' +
        '<td class="p-2">' + unitSelect(e.unitCode) + '</td>' +
        '<td class="p-2 text-center">' + numInput('nom-n2', b.n2) + '</td>' +
        '<td class="p-2 text-center">' + numInput('nom-n1', b.n1) + '</td>' +
        '<td class="p-2 text-center">' + numInput('nom-n', b.n) + '</td>' +
        '<td class="p-2 text-center">' + numInput('nom-active', activeBalanceTotal(b)) + '</td>' +
        '<td class="p-2 whitespace-nowrap"><button type="button" class="nom-edit-balance px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100">Edit saldo</button>' +
        (prot ? '<span class="ml-2 text-xs text-slate-400">Admin</span>' : '<button type="button" class="nom-del ml-2 px-2 py-1.5 rounded-lg text-xs font-semibold text-red-700 hover:bg-red-50" title="Hapus pegawai" aria-label="Hapus pegawai">Hapus pegawai</button>') + '</td></tr>';
    }
    function newRowHtml() {
      return '<tr class="nom-row nom-new border-t bg-yellow-50" data-nip="" data-orig="" data-base="0" data-new="1">' +
        '<td class="p-2 text-center text-slate-500 nom-no">+</td>' +
        '<td class="p-2"><input type="text" class="nom-name w-56 rounded border border-slate-300 px-2 py-1 text-sm" placeholder="Nama lengkap"></td>' +
        '<td class="p-2"><input type="text" class="nom-jab w-72 rounded border border-slate-300 px-2 py-1 text-xs" placeholder="Jabatan (opsional)"></td>' +
        '<td class="p-2"><input type="text" class="nom-nipedit w-48 rounded border border-slate-300 px-2 py-1 text-xs" placeholder="NIP"></td>' +
        '<td class="p-2">' + unitSelect('K') + '</td>' +
        '<td class="p-2 text-center">' + numInput('nom-n2', '', true) + '</td>' +
        '<td class="p-2 text-center">' + numInput('nom-n1', '', true) + '</td>' +
        '<td class="p-2 text-center">' + numInput('nom-n', 12, true) + '</td>' +
        '<td class="p-2 text-center">' + numInput('nom-active', 12, true) + '</td>' +
        '<td class="p-2"><button type="button" class="nom-del px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-50 text-red-700 border border-red-200 hover:bg-red-100">Batal</button></td></tr>';
    }
    function renumber() {
      var i = 0, shown = 0;
      tableEl.querySelectorAll('tr.nom-row').forEach(function (tr) {
        if (tr.dataset.new === '1') return;
        i++;
        tr.querySelector('.nom-no').textContent = i;
        if (!tr.classList.contains('hidden')) shown++;
      });
      countEl.textContent = 'Jumlah pegawai: ' + i + (shown !== i ? ' (tampil ' + shown + ')' : '');
    }
    function renderNominatif() {
      nomReqs = load();
      var currentYear = parseInt(tahunEl.value, 10) || new Date().getFullYear();
      var head = '<table class="min-w-full text-sm"><thead class="sticky top-0 bg-slate-100 z-10"><tr class="text-left"><th class="p-2 text-center">No</th><th class="p-2">Nama</th><th class="p-2">Jabatan</th><th class="p-2">NIP</th><th class="p-2">Unit Kerja</th><th id="nom-n2-heading" class="p-2 text-center">N-2 (' + (currentYear - 2) + ')</th><th id="nom-n1-heading" class="p-2 text-center">N-1 (' + (currentYear - 1) + ')</th><th id="nom-n-heading" class="p-2 text-center">N (' + currentYear + ')</th><th class="p-2 text-center">Cuti Aktif</th><th class="p-2">Aksi</th></tr></thead><tbody id="nom-body">';
      tableEl.innerHTML = head + EMP.map(function (e, i) { return rowHtml(e, i + 1); }).join('') + '</tbody></table>';
      tahunEl.value = tahunEl.value || new Date().getFullYear();
      renumber();
      applySearch();
    }
    tahunEl.addEventListener('input', function () {
      var year = parseInt(tahunEl.value, 10) || new Date().getFullYear();
      document.getElementById('nom-n2-heading').textContent = 'N-2 (' + (year - 2) + ')';
      document.getElementById('nom-n1-heading').textContent = 'N-1 (' + (year - 1) + ')';
      document.getElementById('nom-n-heading').textContent = 'N (' + year + ')';
    });
    function applySearch() {
      var q = searchEl.value.trim().toLowerCase(), qn = normId(searchEl.value);
      tableEl.querySelectorAll('tr.nom-row').forEach(function (tr) {
        if (tr.dataset.new === '1') return;
        var name = (tr.querySelector('.nom-name').value || '').toLowerCase();
        var jab = (tr.querySelector('.nom-jab').value || '').toLowerCase();
        var unit = tr.querySelector('.nom-unit').selectedOptions[0].textContent.toLowerCase();
        var ok = !q || name.indexOf(q) !== -1 || jab.indexOf(q) !== -1 || unit.indexOf(q) !== -1 || normId(tr.querySelector('.nom-nipedit').value).indexOf(qn) !== -1;
        tr.classList.toggle('hidden', !ok);
      });
      renumber();
    }

    openBtn.addEventListener('click', function () {
      if (!canExportExcel()) { toast('Hanya Admin 1 yang dapat membuka Nominatif Pegawai.'); return; }
      var opening = panel.classList.contains('hidden');
      panel.classList.toggle('hidden', !opening);
      if (opening) { searchEl.value = ''; renderNominatif(); panel.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    });
    document.getElementById('nom-close').addEventListener('click', function () { panel.classList.add('hidden'); });
    searchEl.addEventListener('input', applySearch);
    tableEl.addEventListener('input', function (e) {
      var tr = e.target.closest('tr.nom-row');
      if (!tr) return;
      tr.dataset.dirty = '1';
      if (e.target.matches('.nom-n, .nom-n1, .nom-n2')) {
        tr.querySelector('.nom-active').value = activeBalanceTotal({
          n: tr.querySelector('.nom-n').value,
          n1: tr.querySelector('.nom-n1').value,
          n2: tr.querySelector('.nom-n2').value
        });
      }
    });
    tableEl.addEventListener('change', function (e) {
      var tr = e.target.closest('tr.nom-row');
      if (!tr) return;
      tr.dataset.dirty = '1';
      if (e.target.matches('.nom-active')) {
        var balance = {
          n: cleanDays(tr.querySelector('.nom-n').value),
          n1: cleanDays(tr.querySelector('.nom-n1').value),
          n2: cleanDays(tr.querySelector('.nom-n2').value)
        };
        e.target.value = allocateActiveBalanceTotal(balance, e.target.value);
        tr.querySelector('.nom-n').value = balance.n;
        tr.querySelector('.nom-n1').value = balance.n1;
        tr.querySelector('.nom-n2').value = balance.n2;
      }
    });
    tableEl.addEventListener('click', function (e) {
      var editBalance = e.target.closest('.nom-edit-balance');
      if (editBalance) {
        var balanceRow = editBalance.closest('tr.nom-row');
        var editing = balanceRow.dataset.balanceEdit === '1';
        balanceRow.dataset.balanceEdit = editing ? '0' : '1';
        balanceRow.querySelectorAll('.nom-n2, .nom-n1, .nom-n, .nom-active').forEach(function (input) {
          input.readOnly = editing;
          input.classList.toggle('bg-slate-100', editing);
          input.setAttribute('aria-readonly', editing ? 'true' : 'false');
          input.title = editing ? 'Klik Edit saldo untuk mengubah nilai' : '';
        });
        editBalance.textContent = editing ? 'Edit saldo' : 'Selesai edit';
        editBalance.classList.toggle('bg-blue-50', editing);
        editBalance.classList.toggle('text-blue-700', editing);
        editBalance.classList.toggle('border-blue-200', editing);
        editBalance.classList.toggle('bg-green-50', !editing);
        editBalance.classList.toggle('text-green-700', !editing);
        editBalance.classList.toggle('border-green-200', !editing);
        return;
      }
      var del = e.target.closest('.nom-del');
      if (!del) return;
      var tr = del.closest('tr');
      if (tr.dataset.new === '1') { tr.remove(); renumber(); return; }
      var removed = tr.dataset.removed === '1';
      tr.dataset.removed = removed ? '' : '1';
      tr.classList.toggle('bg-red-50', !removed);
      tr.classList.toggle('line-through', !removed);
      del.textContent = removed ? 'Hapus' : 'Batal hapus';
    });
    document.getElementById('nom-add').addEventListener('click', function () {
      var body = document.getElementById('nom-body');
      if (!body) return;
      /* Satu baris baru dulu: isi, lalu Simpan Semua, baru bisa tambah lagi */
      var pending = body.querySelector('tr.nom-new');
      if (pending) {
        toast('Isi nama dan NIP pegawai baru, lalu klik Simpan Semua dulu sebelum menambah lagi.');
        tableEl.scrollTop = 0;
        var pf = pending.querySelector('.nom-name');
        if (pf) pf.focus();
        return;
      }
      body.insertAdjacentHTML('afterbegin', newRowHtml());
      tableEl.scrollTop = 0;
      var first = body.querySelector('tr.nom-new .nom-name');
      if (first) first.focus();
    });

    document.getElementById('nom-save').addEventListener('click', function () {
      if (!canExportExcel()) { toast('Hanya Admin 1 yang dapat menyimpan nominatif.'); return; }
      nomReqs = load();
      var tahun = parseInt(tahunEl.value, 10) || new Date().getFullYear();
      var rows = Array.prototype.slice.call(tableEl.querySelectorAll('tr.nom-row'));
      var balanceRows = [], errors = [], seenKeys = {}, nipChanges = [], removedKeys = [], removedNames = [];
      function cleanNip(tr) { return tr.querySelector('.nom-nipedit').value.trim().replace(/\s+/g, ' '); }

      /* 1. Pemeriksaan: NIP tidak boleh kosong / ganda di antara baris yang dipertahankan */
      rows.forEach(function (tr) {
        if (tr.dataset.removed === '1') return;
        var isNew = tr.dataset.new === '1';
        var name = tr.querySelector('.nom-name').value.trim(), nip = cleanNip(tr), nk = nipKey(nip);
        if (isNew && !name && !nk) return;
        if (!name) { errors.push('Nama pegawai' + (nip ? ' dengan NIP ' + nip : '') + ' tidak boleh kosong.'); return; }
        if (!nk) { errors.push('NIP ' + name + ' tidak boleh kosong.'); return; }
        if (seenKeys[nk]) { errors.push('NIP ' + nip + ' dipakai lebih dari satu pegawai.'); return; }
        seenKeys[nk] = true;
        if (!isNew && nk !== nipKey(tr.dataset.nip) && isProtectedNip(tr.dataset.nip)) errors.push('NIP Admin tidak dapat diubah dari nominatif.');
      });
      if (errors.length) { toast(errors[0]); return; }

      /* 2. Pegawai yang dihapus: keluar dari daftar dan dari seluruh peran sistem */
      rows.forEach(function (tr) {
        if (tr.dataset.new === '1' || tr.dataset.removed !== '1') return;
        var cur = tr.dataset.nip, ck = nipKey(cur), ok = tr.dataset.orig || ck;
        if (isProtectedNip(cur)) { errors.push('Admin 1 / Admin 2 tidak dapat dihapus dari nominatif.'); return; }
        [ok, ck].forEach(function (key) { if (removedKeys.indexOf(key) === -1) removedKeys.push(key); });
        removedNames.push(tr.querySelector('.nom-name').value.trim() || cur);
      });
      if (errors.length) { toast(errors[0]); return; }

      /* 3. Baris baru, perubahan nama/NIP/jabatan/unit, dan sisa cuti */
      rows.forEach(function (tr) {
        if (tr.dataset.removed === '1') return;
        var isNew = tr.dataset.new === '1';
        var name = tr.querySelector('.nom-name').value.trim().replace(/\s+/g, ' ');
        var jab = tr.querySelector('.nom-jab').value.trim();
        var unitCode = tr.querySelector('.nom-unit').value;
        var nip = cleanNip(tr), k = nipKey(nip);
        if (isNew && !name && !k) return;
        var vN = tr.querySelector('.nom-n').value, v1 = tr.querySelector('.nom-n1').value, v2 = tr.querySelector('.nom-n2').value;
        var nipChanged = false, oldNip = '';
        if (!isNew) {
          oldNip = tr.dataset.nip;
          nipChanged = k !== nipKey(oldNip);
          if (nipChanged) nipChanges.push({ oldNip: oldNip, newNip: nip, name: name });
        }
        var existing = effectiveBalance(isNew ? nip : oldNip, null, nomReqs);
        var touched = nipChanged || (tr.dataset.dirty === '1' && (vN !== '' || v1 !== '' || v2 !== '' || existing));
        if (touched || (isNew && (vN !== '' || v1 !== '' || v2 !== ''))) {
          var e0 = existing || {};
          var changed = nipChanged || !existing || String(e0.n) !== String(cleanDays(vN)) || String(e0.n1) !== String(cleanDays(v1)) || String(e0.n2) !== String(cleanDays(v2)) || e0.tahun !== tahun;
          if (changed) balanceRows.push({ nip: k, data: { nip: nip, name: name, tahun: tahun, n: cleanDays(vN), n1: cleanDays(v1), n2: cleanDays(v2),
            ket_n: e0.ket_n || '', ket_n1: e0.ket_n1 || '', ket_n2: e0.ket_n2 || '', updatedAt: Date.now() }, updated_at: new Date().toISOString() });
        }
      });
      if (!supabaseClient) { toast('Server belum terhubung, nominatif tidak dapat disimpan.'); return; }
      var rosterChanged = rows.some(function (tr) {
        return tr.dataset.removed === '1' ||
          tr.dataset.dirty === '1' ||
          (tr.dataset.new === '1' && tr.querySelector('.nom-name').value.trim());
      });
      if (!rosterChanged && !balanceRows.length) { toast('Tidak ada perubahan untuk disimpan.'); return; }
      if (removedNames.length && !confirm('Pegawai berikut akan dihapus dari nominatif dan otomatis dihapus dari seluruh sistem (akun tidak bisa masuk lagi, peran penyetuju/persuratan dicabut):\n\n- ' + removedNames.join('\n- ') + '\n\nAdmin dapat menambahkannya kembali kapan saja. Lanjutkan?')) return;
      var rosterRows = rows.filter(function (tr) { return tr.dataset.removed !== '1'; }).map(function (tr) {
        var employee = BASE_EMP.filter(function (person) {
          return nipKey(person.origNip || person.nip) === nipKey(tr.dataset.orig || tr.dataset.nip);
        })[0];
        return {
          orig_nip: tr.dataset.new === '1' ? '' : (tr.dataset.orig || tr.dataset.nip),
          nip: cleanNip(tr),
          name: tr.querySelector('.nom-name').value.trim().replace(/\s+/g, ' '),
          jabatan: tr.querySelector('.nom-jab').value.trim(),
          unit_code: tr.querySelector('.nom-unit').value,
          atasan_code: employee ? (employee.atasanCode || employee.unitCode) : tr.querySelector('.nom-unit').value
        };
      });
      var deletedNips = rows.filter(function (tr) {
        return tr.dataset.new !== '1' && tr.dataset.removed === '1';
      }).map(function (tr) { return tr.dataset.orig || tr.dataset.nip; });
      var saveBtn = document.getElementById('nom-save');
      saveBtn.disabled = true;
      var rosterSave = rosterChanged
        ? supabaseClient.rpc('admin_save_roster', { p_rows: rosterRows, p_delete: deletedNips }).then(function (res) {
            if (res.error) throw res.error;
            directoryLoaded = false;
            return loadDirectoryFromServer();
          })
        : Promise.resolve();
      rosterSave.then(function () {
        /* sisa cuti: hapus data pegawai yang dihapus / berganti NIP */
        var staleKeys = removedKeys.concat(nipChanges.map(function (ch) { return nipKey(ch.oldNip); }));
        var delStale = Promise.resolve();
        if (staleKeys.length) {
          staleKeys.forEach(function (key) { delete leaveBalances[key]; });
          delStale = Promise.resolve(supabaseClient.from('leave_balances').delete().in('nip', staleKeys))
            .then(function (res) { if (res && res.error) console.warn('Sisa cuti lama tidak terhapus:', res.error); })
            .catch(function (err) { console.warn('Sisa cuti lama tidak terhapus:', err); });
        }
        return delStale.then(function () {
          if (!balanceRows.length) { cacheLocal(LEAVE_BAL_KEY, leaveBalances); return { ok: true }; }
          return supabaseClient.from('leave_balances').upsert(balanceRows).then(function (res) {
            if (res.error) throw res.error;
            balanceRows.forEach(function (r) { leaveBalances[r.nip] = r.data; });
            cacheLocal(LEAVE_BAL_KEY, leaveBalances);
            return { ok: true };
          });
        });
      }).then(function (r) {
        if (r && r.ok) {
          var parts = [];
          if (rosterChanged) parts.push('daftar pegawai');
          if (balanceRows.length) parts.push(balanceRows.length + ' sisa cuti');
          toast('Nominatif tersimpan (' + parts.join(' + ') + ').');
          renderNominatif();
          renderLeaveBalanceAdmin();
          hitungSaldoCuti();
        }
      }).catch(function (error) {
        console.error('Nominatif gagal disimpan:', error);
        toast('Nominatif atau sisa cuti gagal disimpan (' + (error.code || error.message || 'error') + '). Pastikan akun Anda terdaftar sebagai Admin 1.');
      }).then(function () { saveBtn.disabled = false; });
    });
  })();

  var settingsLoading = null;
  function loadSettingsFromServer() {
    if (!supabaseClient) return Promise.resolve();
    if (settingsLoading) return settingsLoading;
    settingsLoading = supabaseClient.from('app_settings').select('key,value').then(function (result) {
      if (result.error) throw result.error;
      var s = {};
      (result.data || []).forEach(function (row) { s[row.key] = row.value; });
      var serverLinks = s.social_links || {};
      var mergedLinks = SOCIAL_SITES.reduce(function (links, site) {
        links[site.id] = normalizeSocialUrl(serverLinks[site.id]) || socialLinks[site.id] || '';
        return links;
      }, {});
      var linksDiffer = SOCIAL_SITES.some(function (site) { return (serverLinks[site.id] || '') !== mergedLinks[site.id]; });
      socialLinks = mergedLinks;
      cacheLocal(SOCIAL_LINKS_KEY, mergedLinks);
      if (linksDiffer) pushSetting('social_links', mergedLinks);
      /* Pulihkan sesi lokal agar user tetap bisa keluar-masuk Beranda tanpa login ulang */
  try {
    var cached = restoreSessionUser();
    if (cached && !currentUser) {
      currentUser = cached;
    }
  } catch(e){}

  renderSocialLinks();
      fillSocialLinkInputs();
    }).catch(function (error) {
      console.error('Gagal memuat pengaturan dari Supabase:', error);
      toast('Pengaturan gagal dimuat dari server. Pastikan tabel app_settings sudah dibuat.');
    }).then(function () { settingsLoading = null; });
    return settingsLoading;
  }
  var additionalStaffRoles = {
    approver: { label: 'Penyetuju', list: APPROVERS, additions: additionalApprovers },
    correspondence: { label: 'Persuratan', list: CORRESPONDENCE, additions: additionalCorrespondence },
    admin: { label: 'Admin', list: ADMINS, additions: additionalAdmins }
  };
  function closeAddStaffForm() {
    addStaffRole = '';
    addStaffForm.reset();
    addStaffError.classList.add('hidden');
    addStaffPanel.classList.add('hidden');
    document.querySelectorAll('[data-add-staff-role]').forEach(function (button) {
      button.setAttribute('aria-expanded', 'false');
    });
  }
  document.querySelectorAll('[data-add-staff-role]').forEach(function (button) {
    button.addEventListener('click', function () {
      if (!canManageAdmin2Settings()) { toast('Hanya Admin 2 yang dapat menambah petugas.'); return; }
      var role = button.dataset.addStaffRole;
      var opening = addStaffPanel.classList.contains('hidden') || addStaffRole !== role;
      closeAddStaffForm();
      if (!opening) return;
      addStaffRole = role;
      addStaffPanel.classList.remove('hidden');
      button.setAttribute('aria-expanded', 'true');
      document.getElementById('admin2-add-staff-heading').textContent = 'Tambah ' + additionalStaffRoles[role].label;
      document.getElementById('btn-save-add-staff').textContent = 'Simpan ' + additionalStaffRoles[role].label;
      var byNip = true;
      document.getElementById('admin2-add-staff-email-wrap').classList.toggle('hidden', byNip);
      document.getElementById('admin2-add-staff-email').required = !byNip;
      document.getElementById('admin2-add-staff-note').textContent = byNip
        ? 'Setelah petugas mendaftar dengan NIP ini dan memverifikasi email, Admin perlu menyetujui penautan akun.'
        : '';
      document.getElementById('admin2-add-staff-name').focus();
    });
  });
  document.getElementById('btn-cancel-add-staff').addEventListener('click', closeAddStaffForm);
  addStaffForm.addEventListener('submit', function (event) {
    event.preventDefault();
    if (!canManageAdmin2Settings()) { toast('Hanya Admin 2 yang dapat menambah petugas.'); return; }
    var roleConfig = additionalStaffRoles[addStaffRole];
    var person = {
      name: document.getElementById('admin2-add-staff-name').value.trim(),
      nip: document.getElementById('admin2-add-staff-nip').value.trim().replace(/\s+/g, ' '),
      title: document.getElementById('admin2-add-staff-title').value.trim(),
      email: ''
    };
    if (!person.email) delete person.email;
    addStaffError.classList.add('hidden');
    var fail = function (message) {
      addStaffError.textContent = message;
      addStaffError.classList.remove('hidden');
    };
    var emailInput = document.getElementById('admin2-add-staff-email');
    var needEmail = false;
    if (!roleConfig || !person.name || !person.nip || !person.title || (needEmail && (!person.email || !emailInput.checkValidity()))) {
      fail('Lengkapi nama, NIP, dan jabatan.');
      return;
    }
    var nipKey = person.nip.replace(/\s/g, '');
    var allStaff = APPROVERS.concat(ADMINS, CORRESPONDENCE);
    if (allStaff.some(function (existing) { return existing.nip.replace(/\s/g, '') === nipKey; })) {
      fail('NIP tersebut sudah terdaftar.');
      return;
    }
    var normalizedName = person.name.toLowerCase().replace(/\s+/g, ' ');
    if (allStaff.some(function (existing) { return existing.name.toLowerCase().replace(/\s+/g, ' ') === normalizedName; })) {
      fail('Nama tersebut sudah terdaftar.');
      return;
    }
    if (person.email && staffEmailAlreadyAssigned(person.email, '')) {
      fail('Email tersebut sudah terdaftar untuk petugas lain.');
      return;
    }
    var saveButton = document.getElementById('btn-save-add-staff');
    saveButton.disabled = true;
    supabaseClient.rpc('admin_add_staff', {
      p_role: addStaffRole,
      p_name: person.name,
      p_nip: person.nip,
      p_title: person.title
    }).then(function (result) {
      if (result.error) throw result.error;
      directoryLoaded = false;
      return loadDirectoryFromServer();
    }).then(function () {
      closeAddStaffForm();
      renderAll();
      toast(roleConfig.label + ' berhasil ditambahkan.');
    }).catch(function (error) {
      console.error('Data petugas gagal disimpan:', error);
      fail('Data petugas gagal disimpan (' + (error.code || error.message || 'error') + ').');
    }).then(function () { saveButton.disabled = false; });
  });
  /* Profil pemohon cuti: pegawai biasa memakai profilnya; penyetuju/admin/persuratan dicocokkan lewat NIP ke daftar pegawai. */
  function applicantProfile(user) {
    if (!user) return null;
    if (user.profile) return user.profile;
    return EMP.filter(function (e) { return e.nip === user.nip; })[0] || null;
  }
  /* Form dikosongkan; data pemohon baru terisi setelah mengetik 3 huruf nama/NIP dan memilih saran. */
  function fillApplicant() {
    ['f-name', 'f-nip', 'f-jab', 'f-masa', 'f-atasan', 'f-atasan-nip'].forEach(function (id) {
      var el = document.getElementById(id);
      el.value = '';
      el.readOnly = id !== 'f-name';
    });
    pickedName = '';
  }
  function isAdmin1() {
    return currentUser && currentUser.role === 'admin' && currentUser.nip === ADMINS[0].nip;
  }
  function isAdmin2() {
    return currentUser && currentUser.role === 'admin' && currentUser.nip === ADMINS[1].nip;
  }
  function isAdmin1Or2() {
    var user = activeUser();
    return !!(user && user.role === 'admin' &&
      (user.nip === ADMINS[0].nip || user.nip === ADMINS[1].nip));
  }
  /* Excel: hanya Admin 1. PDF: pemohon, Persuratan, Admin 1 - hanya setelah surat diterbitkan. */
  function canExportExcel() {
    var u = activeUser();
    return !!(u && u.role === 'admin' && u.nip === ADMINS[0].nip);
  }
  function canDownloadPdf(r) {
    var u = activeUser();
    if (!u || !r || r.status !== 'issued') return false;
    if (canExportExcel()) return true;
    if (u.role === 'correspondence') return true;
    var pn = (testUser && testApplicant) ? testApplicant.nip : u.nip;
    return !!pn && (r.requestedBy === pn || (!r.requestedBy && r.nip === pn));
  }
  function canManageAdmin2Settings() {
    return isAdmin2() && (!testUser || (testUser.role === 'admin' && testUser.nip === ADMINS[1].nip));
  }
  function testActorsForRole(role) {
    if (role === 'employee') return EMP.map(function (person) {
      return { role: role, name: person.n, nip: person.nip, title: person.j, profile: person, email: '' };
    });
    if (role === 'approver') return APPROVERS.map(function (person) {
      return { role: role, name: person.name, nip: person.nip, title: person.title, email: person.email };
    });
    if (role === 'correspondence') return CORRESPONDENCE.map(function (person) {
      return { role: role, name: person.name, nip: person.nip, title: person.title, email: person.email };
    });
    return ADMINS.map(function (person) {
      return { role: 'admin', name: person.name, nip: person.nip, title: person.title, email: person.email };
    });
  }
  function populateTestActors() {
    var actorInput = document.getElementById('admin2-test-actor');
    actorInput.value = '';
    document.getElementById('admin2-test-actor-list').innerHTML = '';
  }
  function actorLabel(person) { return person.name + ' - ' + person.nip; }
  function suggestTestActors() {
    var role = document.getElementById('admin2-test-role').value;
    var t = document.getElementById('admin2-test-actor').value.trim().toLowerCase(), tn = t.replace(/\s+/g, '');
    var list = document.getElementById('admin2-test-actor-list');
    if (t.length < 3) { list.innerHTML = ''; return; }
    list.innerHTML = testActorsForRole(role).filter(function (a) {
      return a.name.toLowerCase().indexOf(t) !== -1 || a.nip.replace(/\s+/g, '').indexOf(tn) === 0;
    }).slice(0, 10).map(function (a) {
      return '<option value="' + esc(actorLabel(a)) + '">' + esc(a.title || '') + '</option>';
    }).join('');
  }
  function findTestActor(role, value) {
    var n = String(value || '').toLowerCase().replace(/\s+/g, '');
    if (!n) return null;
    var all = testActorsForRole(role);
    var hit = all.filter(function (a) { return actorLabel(a).toLowerCase().replace(/\s+/g, '') === n || a.nip.replace(/\s+/g, '') === n; });
    if (!hit.length) hit = all.filter(function (a) { return a.name.toLowerCase().replace(/\s+/g, '') === n; });
    return hit.length === 1 ? hit[0] : null;
  }
  document.getElementById('admin2-test-actor').addEventListener('input', suggestTestActors);
  document.getElementById('admin2-test-role').addEventListener('change', populateTestActors);
  document.getElementById('btn-start-test').addEventListener('click', function () {
    if (!canManageAdmin2Settings()) { toast('Mode uji hanya tersedia untuk akun Admin 2.'); return; }
    var role = document.getElementById('admin2-test-role').value;
    var person = findTestActor(role, document.getElementById('admin2-test-actor').value);
    if (!person) { toast('Ketik 3 huruf nama/NIP lalu pilih identitas uji dari saran.'); return; }
    testApplicant = null;
    person.uid = currentUser.uid;
    person.roleLabel = { employee: 'Pegawai', approver: 'Penyetuju', correspondence: 'Persuratan', admin: 'Admin' }[role];
    testUser = person;
    document.getElementById('admin2-test-status').textContent = 'Mode uji berjalan sebagai ' + person.name + '.';
    updatePushButton();
    fillApplicant();
    showView(role);
  });
  function stopTestMode() {
    if (!testUser) return;
    testUser = null; testApplicant = null;
    document.getElementById('admin2-test-status').textContent = '';
    document.getElementById('leave-form').reset();
    clearSig();
    document.getElementById('admin2-test-role').value = 'employee';
    populateTestActors();
    updatePushButton();
    fillApplicant();
    showView('admin');
  }
  document.getElementById('btn-stop-test').addEventListener('click', stopTestMode);
  populateTestActors();
  /* ---------- Login & pendaftaran mandiri (Supabase Auth) ---------- */
  var pendingUser = null, pendingProfileUser = null, authRestored = false;
  function normId(v) { return String(v || '').toLowerCase().replace(/\s+/g, ''); }
  function findEmployee(q) {
    var n = normId(q);
    if (!n) return null;
    var hit = EMP.filter(function (e) { return normId(e.n + '-' + e.nip) === n || normId(e.nip) === n; });
    if (!hit.length) hit = EMP.filter(function (e) { return normId(e.n) === n; });
    return hit.length === 1 ? hit[0] : null;
  }
  function authMsg(id, text, ok) {
    var el = document.getElementById(id);
    if (!text) { el.className = 'hidden'; el.textContent = ''; return; }
    el.textContent = text;
    el.className = 'text-sm rounded-lg px-3 py-2 border ' + (ok
      ? 'text-green-700 bg-green-50 border-green-200'
      : 'text-red-600 bg-red-50 border-red-200');
  }
  function setAuthTab(tab) {
    var isLogin = tab === 'login';
    document.getElementById('login-form').classList.toggle('hidden', !isLogin);
    document.getElementById('signup-form').classList.toggle('hidden', isLogin);
    document.getElementById('tab-login').classList.toggle('active', isLogin);
    document.getElementById('tab-signup').classList.toggle('active', !isLogin);
    ['login-error', 'login-info', 'signup-error'].forEach(function (id) { authMsg(id, ''); });
  }
  document.getElementById('tab-login').addEventListener('click', function () { setAuthTab('login'); });
  document.getElementById('tab-signup').addEventListener('click', function () { setAuthTab('signup'); });

  function authErrorMessage(error) {
    var messages = {
      'invalid_credentials': 'Email atau kata sandi tidak sesuai.',
      'email_not_confirmed': 'Email belum diverifikasi. Periksa kotak masuk Anda.',
      'user_already_exists': 'Email ini sudah terdaftar. Silakan masuk, atau gunakan "Lupa kata sandi?".',
      'weak_password': 'Kata sandi terlalu lemah. Gunakan minimal 8 karakter.',
      'over_request_rate_limit': 'Terlalu banyak percobaan. Coba lagi beberapa saat.',
      'email_address_invalid': 'Format email tidak valid.',
      'signup_disabled': 'Pendaftaran akun belum diaktifkan di Supabase Authentication.',
      'unexpected_failure': 'Tidak dapat terhubung ke Supabase. Periksa koneksi internet dan konfigurasi proyek.'
    };
    if (error.message && /failed to fetch/i.test(error.message)) {
      return 'Tidak dapat terhubung ke Supabase. Periksa koneksi internet dan URL proyek.';
    }
    return messages[error.code] || 'Terjadi kesalahan (' + (error.code || 'unknown') + ').';
  }

  /* Peran ditentukan dari NIP tertaut di Supabase, bukan metadata akun yang dapat diubah pengguna. */
  var currentLinkedNip = '';
  function buildUser(user) {
    var staff = staffAccountByNip(currentLinkedNip);
    if (staff) {
      return { role: staff.role, name: staff.person.name, nip: staff.person.nip, title: staff.person.title,
               uid: user.id, email: user.email };
    }
    var profile = findEmployee(currentLinkedNip);
    if (profile) {
      return { role: 'employee', name: profile.n, nip: profile.nip, profile: profile, uid: user.id, email: user.email };
    }
    return null;
  }
  function finishLogin(user, silent) {
    return supabaseClient.rpc('claim_employee_link').then(function (linkResult) {
      if (linkResult.error) throw linkResult.error;
      if (linkResult.data !== 'linked') {
        currentUser = null;
        currentLinkedNip = '';
        clearSessionUser();
        pendingProfileUser = null;
        if (linkResult.data === 'unconfirmed') {
          pendingUser = { email: user.email };
          document.getElementById('btn-resend').classList.remove('hidden');
          if (!silent) authMsg('login-error', 'Email belum diverifikasi. Buka tautan verifikasi di email Anda, lalu masuk lagi.');
          showView('login');
          return false;
        }
        pendingUser = null;
        pendingProfileUser = user;
        var fullNameInput = document.getElementById('profile-full-name');
        var nipInput = document.getElementById('profile-nip');
        if (!fullNameInput.value) fullNameInput.value = user.user_metadata && user.user_metadata.full_name || '';
        if (!nipInput.value) nipInput.value = user.user_metadata && user.user_metadata.claimed_nip || '';
        var statusMessage = linkResult.data === 'rejected'
          ? 'Permintaan penautan ditolak. Hubungi Admin untuk memverifikasi identitas Anda.'
          : user.user_metadata && user.user_metadata.full_name && user.user_metadata.claimed_nip
            ? 'Profil tersimpan. Akun belum tertaut; Admin perlu memeriksa nama dan NIP Anda sebelum Anda dapat melanjutkan.'
            : 'Login berhasil. Lengkapi nama dan NIP, lalu simpan profil agar akun dapat ditautkan atau diverifikasi Admin.';
        var statusEl = document.getElementById('profile-setup-status');
        statusEl.textContent = statusMessage;
        statusEl.className = 'text-sm rounded-lg px-3 py-2 border ' + (linkResult.data === 'rejected'
          ? 'text-red-600 bg-red-50 border-red-200'
          : 'text-amber-800 bg-amber-50 border-amber-200');
        showView('profile-setup');
        return false;
      }
      return supabaseClient.from('employee_links').select('nip').eq('user_id', user.id).maybeSingle()
        .then(function (link) {
          if (link.error) throw link.error;
          if (!link.data || !link.data.nip) throw new Error('Akun belum terhubung ke NIP pegawai.');
          currentLinkedNip = link.data.nip;
          return loadDirectoryFromServer();
        })
        .then(function () { return Promise.all([loadSettingsFromServer(), loadLeaveBalancesFromServer()]); })
        .then(function () { return finishLoginCore(user, silent); });
    });
  }
  function finishLoginCore(user, silent) {
    var resendBtn = document.getElementById('btn-resend');
    if (!user.email_confirmed_at) {
      pendingUser = { email: user.email };
      resendBtn.classList.remove('hidden');
      if (!silent) authMsg('login-error', 'Email belum diverifikasi. Buka tautan verifikasi di email Anda, lalu klik Masuk lagi.');
      return Promise.resolve(false);
    }
    var u = buildUser(user);
    if (!u) {
      pendingUser = { email: user.email };
      if (!silent) {
        authMsg('login-error', 'Akun sudah tertaut, tetapi data pegawai tidak ditemukan. Hubungi Admin untuk pemeriksaan.');
      }
      return Promise.resolve(false);
    }
    pendingUser = null;
    pendingProfileUser = null;
    currentUser = u;
    saveSessionUser(u);
    if (isAdmin1Or2()) loadRegistrationRequests();
    startRequestsSync();
    registerPush(false);
    updatePushButton();
    resendBtn.classList.add('hidden');
    document.getElementById('login-form').reset();
    ['login-error', 'login-info'].forEach(function (id) { authMsg(id, ''); });
    safeRender();
    try {
      history.replaceState({ view: u.role, sub: 'menu' }, '');
    } catch (e) {}
    showView(u.role);
    return Promise.resolve(true);
  }

  document.getElementById('login-form').addEventListener('submit', function (e) {
    e.preventDefault();
    authMsg('login-error', ''); authMsg('login-info', '');
    if (!supabaseClient) { authMsg('login-error', supabaseInitError || 'Supabase Authentication tidak tersedia.'); return; }
    var email = document.getElementById('login-email').value.trim();
    var password = document.getElementById('login-password').value;
    if (!email || !password) { authMsg('login-error', 'Email dan kata sandi wajib diisi.'); return; }
    var btn = document.getElementById('login-submit');
    btn.disabled = true; btn.textContent = 'Memeriksa...';
    supabaseClient.auth.signInWithPassword({ email: email, password: password }).then(function (result) {
      if (result.error) throw result.error;
      return finishLogin(result.data.user);
    }).catch(function (error) {
      console.error('Login gagal:', error);
      if (error.code === 'email_not_confirmed') {
        pendingUser = { email: email };
        document.getElementById('btn-resend').classList.remove('hidden');
        authMsg('login-error', 'Email belum diverifikasi. Kirim ulang tautan verifikasi, lalu masuk kembali.');
      } else {
        authMsg('login-error', authErrorMessage(error));
      }
    }).finally(function () {
      btn.disabled = false; btn.textContent = 'Masuk';
    });
  });

  document.getElementById('signup-form').addEventListener('submit', function (e) {
    e.preventDefault();
    authMsg('signup-error', '');
    if (!supabaseClient) { authMsg('signup-error', supabaseInitError || 'Supabase Authentication tidak tersedia.'); return; }
    var email = document.getElementById('signup-email').value.trim();
    var pw = document.getElementById('signup-password').value;
    var pw2 = document.getElementById('signup-password2').value;
    if (!email) { authMsg('signup-error', 'Email wajib diisi.'); return; }
    if (pw.length < 8) { authMsg('signup-error', 'Kata sandi minimal 8 karakter.'); return; }
    if (pw !== pw2) { authMsg('signup-error', 'Kata sandi dan pengulangannya tidak sama.'); return; }
    var btn = document.getElementById('signup-submit');
    btn.disabled = true; btn.textContent = 'Mendaftarkan...';
    var signupHadSession = false;
    supabaseClient.auth.signUp({
      email: email,
      password: pw,
      options: { emailRedirectTo: window.location.href.split('#')[0] }
    }).then(function (result) {
      if (result.error) throw result.error;
      signupHadSession = !!result.data.session;
      return signupHadSession ? supabaseClient.auth.signOut() : null;
    }).then(function (result) {
      if (result && result.error) throw result.error;
      document.getElementById('signup-form').reset();
      setAuthTab('login');
      document.getElementById('login-email').value = email;
      authMsg('login-info', signupHadSession
        ? 'Pendaftaran berhasil. Silakan masuk dengan akun baru.'
        : 'Pendaftaran berhasil. Kami mengirim tautan verifikasi ke ' + email + '. Verifikasi dulu, lalu masuk.', true);
    }).catch(function (error) {
      console.error('Pendaftaran gagal:', error);
      authMsg('signup-error', authErrorMessage(error));
    }).finally(function () {
      btn.disabled = false; btn.textContent = 'Daftar';
    });
  });

  document.getElementById('btn-forgot').addEventListener('click', function () {
    authMsg('login-error', ''); authMsg('login-info', '');
    var email = document.getElementById('login-email').value.trim();
    if (!supabaseClient) { authMsg('login-error', supabaseInitError || 'Supabase Authentication tidak tersedia.'); return; }
    if (!email) { authMsg('login-error', 'Isi email dulu, lalu klik "Lupa kata sandi?".'); return; }
    supabaseClient.auth.resetPasswordForEmail(email, { redirectTo: window.location.href.split('#')[0] }).then(function (result) {
      if (result.error) throw result.error;
      authMsg('login-info', 'Jika email terdaftar, tautan untuk mengatur ulang kata sandi sudah dikirim.', true);
    }).catch(function (error) {
      console.error('Permintaan reset password gagal:', error);
      authMsg('login-error', authErrorMessage(error));
    });
  });
  document.getElementById('btn-resend').addEventListener('click', function () {
    authMsg('login-error', ''); authMsg('login-info', '');
    if (!pendingUser) { authMsg('login-error', 'Masukkan email dan kata sandi, lalu klik Masuk terlebih dahulu.'); return; }
    supabaseClient.auth.resend({ type: 'signup', email: pendingUser.email }).then(function (result) {
      if (result.error) throw result.error;
      authMsg('login-info', 'Email verifikasi dikirim ulang. Cek kotak masuk atau folder spam.', true);
    }).catch(function (error) {
      console.error('Pengiriman ulang email verifikasi gagal:', error);
      authMsg('login-error', authErrorMessage(error));
    });
  });
  document.getElementById('profile-setup-form').addEventListener('submit', function (e) {
    e.preventDefault();
    authMsg('profile-setup-error', '');
    if (!supabaseClient || !pendingProfileUser) {
      authMsg('profile-setup-error', 'Sesi login tidak tersedia. Silakan masuk kembali dengan email dan kata sandi.');
      return;
    }
    var fullName = document.getElementById('profile-full-name').value.trim();
    var nip = document.getElementById('profile-nip').value.trim().replace(/\s+/g, ' ');
    if (!fullName || !nip) {
      authMsg('profile-setup-error', 'Nama lengkap dan NIP wajib diisi.');
      return;
    }
    var button = document.getElementById('profile-setup-submit');
    button.disabled = true;
    button.textContent = 'Menyimpan...';
    supabaseClient.auth.updateUser({ data: { full_name: fullName, claimed_nip: nip } }).then(function (result) {
      if (result.error) throw result.error;
      pendingProfileUser = result.data.user;
      return finishLogin(result.data.user);
    }).catch(function (error) {
      console.error('Penyimpanan profil pegawai gagal:', error);
      authMsg('profile-setup-error', authErrorMessage(error));
    }).finally(function () {
      button.disabled = false;
      button.textContent = 'Simpan profil & cek verifikasi';
    });
  });
  document.getElementById('profile-setup-logout').addEventListener('click', doLogout);

  function doLogout() {
    /* Keluar langsung: pembersihan (push, realtime, sesi Supabase) berjalan di latar
       belakang dengan batas waktu supaya tombol tidak pernah macet. */
    var withTimeout = function (promise, ms) {
      return Promise.race([Promise.resolve(promise), new Promise(function (resolve) { setTimeout(resolve, ms); })]);
    };
    var client = supabaseClient;
    try { stopRequestsSync(); } catch (e) { console.error('Hentikan sinkronisasi gagal:', e); }
    currentUser = null; currentLinkedNip = ''; testUser = null; pendingUser = null; pendingProfileUser = null;
    clearSessionUser();
    try {
      document.getElementById('login-form').reset();
      document.getElementById('signup-form').reset();
      document.getElementById('profile-setup-form').reset();
      authMsg('profile-setup-status', '');
      authMsg('profile-setup-error', '');
    } catch (e) { console.error(e); }
    try { updatePushButton(); } catch (e) { console.error(e); }
    try { history.replaceState({ view: 'home', sub: 'menu' }, ''); } catch (e) {}
    showView('home');
    window.scrollTo(0, 0);
    withTimeout(disconnectPush(), 3000).catch(function (e) { console.error('Logout push gagal:', e); });
    if (client) {
      withTimeout(client.auth.signOut({ scope: 'local' }), 5000).then(function (result) {
        if (result && result.error) console.error('Supabase sign-out gagal:', result.error);
      }).catch(function (error) { console.error('Supabase sign-out gagal:', error); });
    }
  }

  /* Tombol "Beranda" di dalam aplikasi: kembali ke halaman awal TANPA logout.
     Logout hanya lewat tombol "Logout" di halaman awal (#home-btn-logout). */
    /* Tombol "Beranda" di dalam aplikasi: kembali ke halaman awal TANPA logout.
     Logout hanya lewat tombol "Logout" di halaman awal (#home-btn-logout). */
  document.getElementById('btn-logout').addEventListener('click', function () {
    showView('home');
  });
  document.addEventListener('click', function (e) {
    var b = e.target.closest('#home-btn-logout');
    if (!b) return;
    if (activeUser()) {
      doLogout();
      toast('Berhasil keluar dari akun, BOS!');
    } else {
      toast('BOS belum login ke akun!');
    }
  });
  /* Pulihkan sesi setelah halaman dimuat ulang. */
  if (supabaseClient) {
    supabaseClient.auth.onAuthStateChange(function (event, session) {
      if (event !== 'INITIAL_SESSION' || authRestored) return;
      authRestored = true;
      if (session && session.user) setTimeout(function () {
        finishLogin(session.user, true).catch(function (error) {
          console.error('Pemulihan sesi gagal:', error);
          authMsg('login-error', authErrorMessage(error));
        });
      }, 0);
    });
  }
  /* ---------- Timeline pengajuan terakhir ---------- */
  function renderLastRequestTimeline() {
    var el = document.getElementById('last-request-timeline');
    if (!el) return;
    var user = activeUser();
    var hn = null;
    try { hn = user ? ((typeof testUser !== 'undefined' && testUser && typeof testApplicant !== 'undefined' && testApplicant) ? testApplicant.nip : user.nip) : null; } catch(e) { hn = user ? user.nip : null; }
    var mine = hn ? load().filter(function (r) { return (r.requestedBy || r.nip) === hn; }).sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); }) : [];
    var r = mine[0];
    if (!r) { el.innerHTML = '<p class="text-sm text-slate-500">Belum ada pengajuan cuti.</p>'; return; }
    var steps = [
      { t: 'Pengajuan Terkirim', d: 'Tgl ' + fmtDate(r.start) + ' – ' + fmtDate(r.end) + ' • ' + (TYPE_LABEL[r.type] || r.type) },
      { t: 'Diverifikasi Admin', d: r.firstApprovedAt ? 'Diverifikasi pada ' + new Date(r.firstApprovedAt).toLocaleDateString('id-ID') : 'Menunggu verifikasi Admin' },
      { t: 'Menunggu TTD Kasubag', d: r.firstApprover ? r.firstApprover : '' },
      { t: 'Menunggu TTD Kabag', d: r.secondApprover ? r.secondApprover : 'Tidak diperlukan' },
      { t: 'SK Terbit / Selesai', d: r.letterNumber ? 'No. ' + r.letterNumber : (r.status === 'issued' ? 'Selesai' : 'Menunggu SK') }
    ];
    var currentByStatus = { pending_direct: 2, pending_next: 3, pending_correspondence: 4, pending_admin_issue: 4, issued: 5, draft: 0 };
    var current = currentByStatus[r.status];
    var rejectedIdx = -1;
    var isRejected = r.status === 'rejected';
    if (isRejected) { rejectedIdx = r.rejectedStage === 'second' ? 3 : 2; if (!r.rejectedStage) rejectedIdx = 1; current = rejectedIdx; }
    if (current === undefined) current = 0;
    var CHECK = '<svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0L3.3 9.7a1 1 0 011.4-1.4l3.8 3.8 6.8-6.8a1 1 0 011.4 0z" clip-rule="evenodd"/></svg>';
    var CROSS = '<svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path d="M5.3 5.3a1 1 0 011.4 0L10 8.6l3.3-3.3a1 1 0 111.4 1.4L11.4 10l3.3 3.3a1 1 0 01-1.4 1.4L10 11.4l-3.3 3.3a1 1 0 01-1.4-1.4L8.6 10 5.3 6.7a1 1 0 010-1.4z"/></svg>';
    var html = '<ol class="relative">';
    steps.forEach(function (s, i) {
      var state = i < current ? 'done' : (i === current ? 'now' : 'todo');
      if (r.status === 'issued') state = 'done';
      var circle, title, note = s.d ? '<div class="text-xs text-slate-500 mt-0.5">' + esc(s.d) + '</div>' : '';
      if (i === rejectedIdx && isRejected) {
        circle = 'bg-red-600 text-white'; title = 'text-red-700 font-semibold';
        var reason = r.rejectedReason || r.rejectReason || r.alasanPenolakan || '';
        note = '<div class="text-xs text-red-700 mt-1">Ditolak oleh ' + esc(r.rejectedBy || 'penyetuju') + '</div><div class="mt-1.5 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-medium text-red-700">Alasan: ' + esc(reason || 'tidak dicatat') + '</div>';
      } else if (isRejected && i > rejectedIdx) { circle = 'bg-slate-200 text-slate-400'; title = 'text-slate-400'; }
      else if (state === 'done') { circle = 'bg-green-600 text-white'; title = 'text-slate-800'; }
      else if (state === 'now') { circle = 'bg-blue-600 text-white ring-4 ring-blue-100'; title = 'text-blue-700 font-semibold'; }
      else { circle = 'bg-slate-200 text-slate-400'; title = 'text-slate-400'; }
      var ico = (i === rejectedIdx && isRejected) ? CROSS : (state === 'done' ? CHECK : String(i + 1));
      var last = i === steps.length - 1;
      html += '<li class="relative flex gap-3 pb-6' + (last ? ' pb-0' : '') + '">' + (last ? '' : '<span class="absolute left-4 top-9 -ml-px h-full w-0.5 ' + (state === 'done' && !isRejected ? 'bg-green-300' : 'bg-slate-200') + '"></span>') + '<span class="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold shadow-sm ' + circle + '">' + ico + '</span><div class="pt-1 flex-1"><div class="text-sm ' + title + '">' + esc(s.t) + '</div>' + note + '</div></li>';
    });
    el.innerHTML = html + '</ol>';
    if (isRejected) el.innerHTML += '<div class="mt-4 rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700 font-medium">Status akhir: Ditolak</div>';
    else if (r.status === 'issued') el.innerHTML += '<div class="mt-4 rounded-xl bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-700 font-medium">Status akhir: SK Terbit – surat dapat diunduh di Riwayat.</div>';
    else if (r.status === 'draft') el.innerHTML += '<div class="mt-4 rounded-xl bg-slate-50 border border-slate-200 px-4 py-3 text-sm text-slate-600 font-medium">Status: Draft – belum dikirim ke Admin.</div>';
  }


  function hitungHariKerja(tanggalMulai, tanggalSelesai) {
    if (!tanggalMulai || !tanggalSelesai) return 0;
    var s = new Date(tanggalMulai + 'T00:00:00'), e = new Date(tanggalSelesai + 'T00:00:00');
    if (isNaN(s) || isNaN(e) || e < s) return 0;
    var n = 0;
    for (var d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
      var w = d.getDay();
      if (w !== 0 && w !== 6) n++;
    }
    return n;
  }
  function updateHariKerjaInfo() {
    var el = document.getElementById('f-workdays-info');
    if (!el) return;
    var s = document.getElementById('f-start').value, e = document.getElementById('f-end').value;
    if (!s || !e) { el.classList.add('hidden'); el.textContent = ''; return; }
    if (new Date(e) < new Date(s)) {
      el.textContent = 'Tanggal selesai tidak boleh sebelum tanggal mulai.';
    } else {
      el.textContent = 'Total: ' + hitungHariKerja(s, e) + ' hari kerja';
    }
    el.classList.remove('hidden');
  }
  ['f-start', 'f-end'].forEach(function (id) {
    var inp = document.getElementById(id);
    if (!inp) return;
    inp.addEventListener('input', updateHariKerjaInfo);
    inp.addEventListener('change', updateHariKerjaInfo);
  });
  document.getElementById('leave-form').addEventListener('reset', function () { setTimeout(updateHariKerjaInfo, 0); });

  /* ---------- Peringatan aturan: pengajuan < 3 hari kerja ---------- */
  var MIN_HARI_KERJA_PENGAJUAN = 3;
  function isoLocal(d) {
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function updateRuleWarning() {
    var el = document.getElementById('leave-rule-warning');
    if (!el) return;
    var start = document.getElementById('f-start').value;
    if (!start) { el.classList.add('hidden'); return; }
    var tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    /* jumlah hari kerja dari besok sampai tanggal mulai (hari ini tidak dihitung) */
    var lead = start >= isoLocal(tomorrow) ? hitungHariKerja(isoLocal(tomorrow), start) : 0;
    el.classList.toggle('hidden', lead >= MIN_HARI_KERJA_PENGAJUAN);
  }
  var startInput = document.getElementById('f-start');
  startInput.addEventListener('input', updateRuleWarning);
  startInput.addEventListener('change', updateRuleWarning);
  document.getElementById('leave-form').addEventListener('reset', function () { setTimeout(updateRuleWarning, 0); });

  /* ---------- Saldo cuti tahunan ---------- */
  var JATAH_CUTI_TAHUNAN = 12;
  function hitungSaldoCuti() {
    var user = activeUser();
    var elRemain = document.getElementById('leave-balance-remaining');
    if (!elRemain) return null;
    var year = new Date().getFullYear();
    var hn = user ? ((testUser && typeof testApplicant !== 'undefined' && testApplicant) ? testApplicant.nip : user.nip) : null;
    var used = 0;
    if (hn) {
      load().forEach(function (r) {
        var owner = r.requestedBy || r.nip;
        if (owner !== hn || r.status !== 'issued' || r.type !== 'Annual') return;
        if (!r.start || !r.end || new Date(r.start).getFullYear() !== year) return;
        used += hitungHariKerja(r.start, r.end);
      });
    }
    var bal = hn ? effectiveBalance(hn) : null;
    if (bal) {
      /* sisa cuti yang diisi Admin 1 */
      var totalSisa = activeBalanceTotal(bal);
      elRemain.textContent = totalSisa;
      elRemain.className = 'text-2xl font-bold ' + (totalSisa === 0 ? 'text-red-600' : 'text-green-700');
      document.getElementById('leave-balance-n2').textContent = bal.n2 || 0;
      document.getElementById('leave-balance-n1').textContent = bal.n1 || 0;
      document.getElementById('leave-balance-n').textContent = bal.n || 0;
      document.getElementById('leave-balance-year').textContent = '(' + bal.tahun + ')';
      document.getElementById('leave-balance-warning').classList.toggle('hidden', totalSisa !== 0);
      return { jatah: totalSisa, terpakai: 0, sisa: totalSisa };
    }
    var remaining = Math.max(0, JATAH_CUTI_TAHUNAN - used);
    elRemain.textContent = hn ? remaining : '-';
    elRemain.className = 'text-2xl font-bold ' + (hn && remaining === 0 ? 'text-red-600' : 'text-green-700');
    document.getElementById('leave-balance-n2').textContent = 0;
    document.getElementById('leave-balance-n1').textContent = 0;
    document.getElementById('leave-balance-n').textContent = hn ? remaining : JATAH_CUTI_TAHUNAN;
    document.getElementById('leave-balance-year').textContent = '(' + year + ')';
    document.getElementById('leave-balance-warning').classList.toggle('hidden', !(hn && remaining === 0));
    return { jatah: JATAH_CUTI_TAHUNAN, terpakai: used, sisa: remaining };
  }
  function renderEmployeeProfile() {
    var el = document.getElementById('employee-profile');
    if (!el) return;
    var user = activeUser();
    var p = applicantProfile(user);
    if (!user || !p) {
      el.innerHTML = '<p class="text-sm text-slate-500">Masuk dengan akun yang terdaftar di daftar pegawai untuk melihat profil dan membuat pengajuan.</p>';
      return;
    }
    el.innerHTML = '<div><h3 class="font-semibold text-blue-900">' + esc(user.name) + '</h3><p class="text-sm text-slate-600">NIP ' + esc(user.nip) + '</p>' +
      '<p class="text-sm text-slate-500">' + esc(p.unit || 'Unit kerja belum tercatat') + '</p></div>';
  }
  function renderEmployeeHistory() {
    var el = document.getElementById('employee-history-table');
    if (!el) return;
    var user = activeUser();
    if (!user || !applicantProfile(user)) {
      el.innerHTML = empty('🔒', 'Silakan masuk terlebih dahulu', 'Riwayat cuti hanya tersedia untuk akun pemohon.');
      return;
    }
    var hn = testUser && testApplicant ? testApplicant.nip : user.nip;
    var own = load().filter(function (r) {
      return r.requestedBy ? r.requestedBy === hn : r.nip === hn;
    }).sort(function (a, b) { return b.createdAt - a.createdAt; });
    if (!own.length) {
      el.innerHTML = empty('📭', 'Belum ada permohonan cuti', 'Permohonan yang Anda ajukan akan tercatat di sini.');
      return;
    }
        el.innerHTML = table(['Tanggal Pengajuan', 'Jenis Cuti', 'Periode', 'Status', 'Aksi'], own.map(function (r) {
      var isDraft = r.status === 'draft';
      var letter = '';
      if (isDraft) {
        letter = '<div class="flex flex-col gap-2"><span class="text-xs text-slate-500">' + (r.returnedBy ? '<b>Dikembalikan oleh ' + esc(r.returnedBy) + ':</b> ' + esc(r.returnedNote || '') + ' Ubah tanggal lalu ajukan ulang.' : 'Draft belum dikirim.') + '</span><div class="flex gap-2">' + btn('edit-draft', r.id, '✏️ Edit', 'draft') + (r.returnedBy ? '' : btn('send-draft', r.id, '📤 Kirim', 'ok')) + btn('delete-draft', r.id, '🗑️ Hapus', 'del') + '</div></div>';
      } else if (r.status === 'issued') {
        letter = '<div class="font-semibold text-slate-800">' + esc(r.letterNumber || 'Nomor belum tersedia') + '</div>' +
          '<div class="text-xs text-green-700 mb-2">Surat PDF telah tersedia sejak ' +
          (r.letterDeliveredAt ? new Date(r.letterDeliveredAt).toLocaleDateString('id-ID') : 'surat diterbitkan') + '</div>' +
          btn('employee-pdf', r.id, '⬇ Unduh PDF', 'ok');
      } else {
        letter = '<span class="text-xs text-slate-500">PDF tersedia setelah Admin menerbitkan surat.</span>';
      }
      return [new Date(r.createdAt).toLocaleDateString('id-ID'), esc(TYPE_LABEL[r.type] || r.type),
        periodCell(r), badge(r), letter];
    }));
  }
  function masaKerja(nip) {
    var d = nip.replace(/\s+/g, '');
    var y = parseInt(d.substr(8, 4), 10), m = parseInt(d.substr(12, 2), 10);
    if (!y || !m) return '';
    var now = new Date(), t = (now.getFullYear() - y) * 12 + (now.getMonth() + 1 - m);
    if (t < 0) return '';
    return Math.floor(t / 12) + ' th ' + (t % 12) + ' bln';
  }
  var pickedName = '';
  var nameIn = document.getElementById('f-name'), sugg = document.createElement('div'), sIdx = -1, sList = [];
  sugg.className = 'hidden absolute left-0 right-0 top-full mt-1 z-20 bg-white border border-slate-300 rounded-lg shadow-lg max-h-64 overflow-auto';
  nameIn.parentNode.style.position = 'relative';
  nameIn.parentNode.appendChild(sugg);
  function pick(e) {
    var route = resolveRoute(e);
    nameIn.value = e.n;
    document.getElementById('f-nip').value = e.nip;
    document.getElementById('f-jab').value = e.j;
    document.getElementById('f-masa').value = masaKerja(e.nip);
    document.getElementById('f-atasan').value = route.first;
    var approver = Object.keys(HEAD).map(function (code) { return HEAD[code]; })
      .filter(function (person) { return person[0] === route.first; })[0];
    document.getElementById('f-atasan-nip').value = approver ? approver[1] : e.anip;
    pickedName = e.n;
    if (testUser) testApplicant = e;
    sugg.classList.add('hidden');
  }
  function showSugg() {
    var q = nameIn.value.trim().toLowerCase().replace(/\s+/g, ' '), qn = q.replace(/\s+/g, '');
    if (pickedName && nameIn.value !== pickedName) {
      ['f-nip', 'f-jab', 'f-masa', 'f-atasan', 'f-atasan-nip'].forEach(function (id) { document.getElementById(id).value = ''; });
      pickedName = '';
    }
    if (q.length < 3) { sugg.classList.add('hidden'); return; }
    var own = applicantProfile(activeUser());
    var pool = testUser ? EMP : (own ? [own] : []);
    sList = pool.filter(function (e) { return e.n.toLowerCase().indexOf(q) !== -1 || e.nip.replace(/\s+/g, '').indexOf(qn) === 0; }).slice(0, 8);
    sIdx = -1;
    if (!sList.length) { sugg.classList.add('hidden'); return; }
    sugg.innerHTML = sList.map(function (e, i) {
      return '<div data-i="' + i + '" class="sg px-3 py-2 cursor-pointer hover:bg-blue-50 border-b border-slate-100 last:border-0"><div class="text-sm font-medium">' + esc(e.n) +
        '</div><div class="text-xs text-slate-500">' + esc(e.nip) + ' &middot; ' + esc(e.j) + '</div></div>';
    }).join('');
    sugg.classList.remove('hidden');
  }
  function hilite() {
    sugg.querySelectorAll('.sg').forEach(function (el, i) { el.classList.toggle('bg-blue-50', i === sIdx); });
  }
  nameIn.addEventListener('input', showSugg);
  nameIn.addEventListener('focus', showSugg);
  nameIn.addEventListener('keydown', function (e) {
    if (sugg.classList.contains('hidden')) return;
    if (e.key === 'ArrowDown') { sIdx = Math.min(sIdx + 1, sList.length - 1); hilite(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sIdx = Math.max(sIdx - 1, 0); hilite(); e.preventDefault(); }
    else if (e.key === 'Enter' && sIdx >= 0) { pick(sList[sIdx]); e.preventDefault(); }
    else if (e.key === 'Escape') { sugg.classList.add('hidden'); }
  });
  sugg.addEventListener('mousedown', function (e) {
    var el = e.target.closest('.sg');
    if (el) { e.preventDefault(); pick(sList[+el.dataset.i]); }
  });
  nameIn.addEventListener('blur', function () { setTimeout(function () { sugg.classList.add('hidden'); }, 120); });

  /* ---------- Halaman Karyawan: menu, aturan, form ---------- */
  var RULES = {
    A: { t: 'A. Dasar Hukum', list: [
      'Undang-Undang No. 20 Tahun 2023 tentang Aparatur Sipil Negara',
      'Peraturan Pemerintah No. 11 Tahun 2017 jo. PP No. 17 Tahun 2020 tentang Manajemen PNS',
      'Peraturan BKN No. 7 Tahun 2021 tentang Prosedur Pemberian Cuti',
      'SKB 3 Menteri No. 1205/2026, No. 3/2026, No. 2/2026 tentang Hari Libur Nasional dan Cuti Bersama Tahun 2027',
      'Surat Edaran Dirjen Perhubungan Laut tentang Pelaksanaan Piket pada Masa Angkutan Lebaran dan Nataru'] },
    B: { t: 'B. Jenis-Jenis Cuti', types: [
      { t: '1. Cuti Tahunan', pts: [
        'Hak 12 (dua belas) hari kerja setiap tahun bagi PNS yang telah bekerja minimal 1 tahun secara terus-menerus.',
        'Permohonan diajukan minimal 5 hari kerja sebelum pelaksanaan.',
        'Sisa cuti yang tidak diambil maksimal 18 hari dapat ditangguhkan untuk tahun berikutnya.'] },
      { t: '2. Cuti Besar', pts: [
        'Diberikan 3 (tiga) bulan bagi PNS dengan masa kerja 5 tahun terus-menerus.',
        'Diperuntukkan untuk ibadah keagamaan dan persalinan anak ke-4 dan seterusnya.',
        'Selama cuti besar, hak gaji penuh tetap diberikan.'] },
      { t: '3. Cuti Sakit', pts: [
        '1-14 hari: dengan surat keterangan dokter.',
        'Lebih dari 14 hari: wajib surat keterangan dari Rumah Sakit Pemerintah.',
        'Surat keterangan wajib mencantumkan diagnosa dan lama istirahat yang diperlukan.'] },
      { t: '4. Cuti Melahirkan', pts: [
        'Diberikan selama 3 (tiga) bulan untuk kelahiran anak pertama sampai ketiga.',
        'Rincian: 1 bulan sebelum dan 2 bulan sesudah persalinan.',
        'Wajib melampirkan surat keterangan dokter/bidan.'] },
      { t: '5. Cuti Alasan Penting', pts: [
        'Diberikan maksimal 2 (dua) bulan.',
        'Alasan: menikah, istri melahirkan, keluarga inti sakit keras/meninggal, atau terkena bencana alam.',
        'Wajib melampirkan bukti pendukung (surat nikah, surat rawat inap, dll).'] },
      { t: '6. Cuti Bersama', pts: [
        'Ditetapkan oleh Pemerintah setiap tahun dan memotong hak cuti tahunan.',
        'Bagi unit pelayanan Perhubungan Laut (KSOP, UPP, Distrik Navigasi, Pangkalan PLP), cuti bersama TIDAK meliburkan operasional. Tetap dilaksanakan piket pelayanan.'] },
      { t: '7. Cuti di Luar Tanggungan Negara (CLTN)', pts: [
        'Diberikan maksimal 3 tahun dan dapat diperpanjang 1 tahun.',
        'Alasan pribadi dan mendesak (mendampingi suami/istri tugas negara/belajar).',
        'Bukan merupakan hak, dapat ditolak oleh Pejabat Pembina Kepegawaian (PPK).'] }] },
    C: { t: 'C. Ketentuan Khusus', items: [
      ['Kewajiban Pelayanan', 'Seluruh Unit Pelaksana Teknis (UPT) di lingkungan Direktorat Jenderal Perhubungan Laut yang memberikan pelayanan langsung kepada masyarakat (kepelabuhanan, kesyahbandaran, kenavigasian) WAJIB mengatur penugasan pegawai pada hari libur nasional dan cuti bersama.'],
      ['Larangan Cuti Operasional', 'Pengajuan cuti tahunan ditutup pada H-7 sampai H+7 Masa Angkutan Lebaran dan Natal-Tahun Baru (Nataru), kecuali cuti sakit dan cuti melahirkan.'],
      ['Pelimpahan Tugas', 'Setiap pengajuan cuti wajib melampirkan Surat Pelimpahan Tugas kepada rekan kerja untuk menjamin kelancaran pelayanan.'],
      ['Persetujuan Berjenjang', 'Alur persetujuan: Staf Pelaksana \u2192 Kepala Seksi/Bidang \u2192 Kepala Bagian Tata Usaha \u2192 Kepala UPT (Kepala KSOP/UPP).']] },
    D: { t: 'D. Persyaratan Administrasi', list: [
      'Blanko permohonan cuti (Form F-01)',
      'Surat izin sementara pelaksanaan cuti dari atasan langsung',
      'Surat pelimpahan tugas',
      'Fotocopy SK Pangkat terakhir',
      'Dokumen pendukung sesuai jenis cuti'] }
  };
  var rTab = 'A', rSub = 0;
  function chip(attr, val, label, on, cls) {
    return '<button type="button" ' + attr + '="' + val + '" class="' + (cls || '') + ' px-3 py-2 rounded-lg text-sm font-semibold border transition ' +
      (on ? 'bg-blue-700 text-white border-blue-700' : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50') + '">' + label + '</button>';
  }
  function renderRules() {
    document.getElementById('rules-tabs').innerHTML = Object.keys(RULES).map(function (k) {
      return chip('data-rtab', k, RULES[k].t, k === rTab);
    }).join('');
    var r = RULES[rTab], h = '';
    var ol = function (a) { return '<ol class="list-decimal pl-5 space-y-2 text-sm text-slate-700">' + a.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ol>'; };
    if (r.list) h = ol(r.list);
    else if (r.items) {
      h = '<div class="space-y-3">' + r.items.map(function (x) {
        return '<div class="border border-slate-200 rounded-lg p-3"><p class="font-semibold text-blue-900 text-sm">' + x[0] + '</p><p class="text-sm text-slate-700 mt-1">' + x[1] + '</p></div>';
      }).join('') + '</div>';
    } else {
      var t = r.types[rSub];
      h = '<div class="flex flex-wrap gap-2 mb-4">' + r.types.map(function (x, i) { return chip('data-rsub', i, x.t, i === rSub); }).join('') + '</div>' +
        '<div class="border border-slate-200 rounded-lg p-4"><p class="font-semibold text-blue-900 mb-2">' + t.t + '</p>' +
        '<ol class="list-[lower-alpha] pl-5 space-y-2 text-sm text-slate-700">' + t.pts.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ol></div>';
    }
    document.getElementById('rules-body').innerHTML = '<h4 class="font-semibold mb-3">' + r.t + '</h4>' + h;
  }
  function empShow(p, fromPop) {
    var valid = ['menu', 'rules', 'form', 'history'];
    if (valid.indexOf(p) === -1) p = 'menu';
    valid.forEach(function (x) {
      var el = document.getElementById('emp-' + x);
      if (el) el.classList.toggle('hidden', x !== p);
    });
    if (p === 'rules') renderRules();
    if (p === 'history') renderEmployeeHistory();
    if (p === 'form') {
      fillApplicant();
      ['leave-balance-n2', 'leave-balance-n1', 'leave-balance-n', 'leave-balance-remaining'].forEach(function (id) {
        document.getElementById(id).textContent = '...';
      });
      loadLeaveBalancesFromServer().then(function (loaded) {
        if (!loaded) {
          toast('Saldo cuti gagal diperbarui dari server. Muat ulang halaman sebelum mengajukan.');
          return;
        }
        hitungSaldoCuti();
      });
    }
    if (!fromPop) {
      try {
        var cur = history.state || {};
        if (cur.view !== 'employee' || cur.sub !== p) {
          history.pushState({ view: 'employee', sub: p }, '');
        }
      } catch (e) {}
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  document.addEventListener('click', function (e) {
    var sb = e.target.closest('[data-staff-emp]');
    if (sb) { showView('employee'); empShow(sb.dataset.staffEmp); return; }
    var a = e.target.closest('[data-emp]');
    if (a) { empShow(a.dataset.emp); return; }
    var t = e.target.closest('[data-rtab]');
    if (t) { rTab = t.dataset.rtab; rSub = 0; renderRules(); return; }
    var u = e.target.closest('[data-rsub]');
    if (u) { rSub = +u.dataset.rsub; renderRules(); }
  });

  /* ---------- Signature pad ---------- */
  var cv = document.getElementById('sig'), cx = cv.getContext('2d'), drawing = false, inked = false;
  cx.lineWidth = 2.5; cx.lineCap = 'round'; cx.lineJoin = 'round'; cx.strokeStyle = '#111';
  function pos(e) {
    var r = cv.getBoundingClientRect();
    return { x: (e.clientX - r.left) * cv.width / r.width, y: (e.clientY - r.top) * cv.height / r.height };
  }
  cv.addEventListener('pointerdown', function (e) {
    drawing = true; inked = true; cv.setPointerCapture(e.pointerId);
    var p = pos(e); cx.beginPath(); cx.moveTo(p.x, p.y); cx.lineTo(p.x + 0.1, p.y + 0.1); cx.stroke();
    e.preventDefault();
  });
  cv.addEventListener('pointermove', function (e) {
    if (!drawing) return;
    var p = pos(e); cx.lineTo(p.x, p.y); cx.stroke(); cx.beginPath(); cx.moveTo(p.x, p.y);
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (n) {
    cv.addEventListener(n, function () { drawing = false; });
  });
  function clearSig() { cx.clearRect(0, 0, cv.width, cv.height); inked = false; }
  document.getElementById('sig-clear').addEventListener('click', clearSig);

  /* ---------- Export Excel (format Formulir Cuti) ---------- */
  function buildSheet(wb, sn, r) {
    var ws = wb.addWorksheet(sn, {
      views: [{ showGridLines: false }],
      pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 1,
        horizontalCentered: true, verticalCentered: true, printArea: 'A1:H61', margins: { left: 0.6, right: 0.6, top: 0.6, bottom: 0.6, header: 0.2, footer: 0.2 } }
    });
    for (var c = 1; c <= 8; c++) ws.getColumn(c).width = 13;
    var thin = { style: 'thin' }, GREY = 'FFE7E6E6';
    function addr(a) { var m = /^([A-Z])(\d+)$/.exec(a); return { c: m[1].charCodeAt(0) - 64, r: +m[2] }; }
    function put(range, val, o) {
      o = o || {};
      var p = range.split(':'), a = addr(p[0]), b = addr(p[1] || p[0]);
      if (a.c !== b.c || a.r !== b.r) ws.mergeCells(a.r, a.c, b.r, b.c);
      var cell = ws.getCell(a.r, a.c);
      cell.value = val;
      cell.alignment = { vertical: o.v || 'middle', horizontal: o.h || 'left', wrapText: true };
      cell.font = { name: 'Arial', size: o.size || 10, bold: !!o.b, italic: !!o.i, underline: !!o.u };
      if (o.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: o.fill } };
      if (o.box !== false) {
        for (var rr = a.r; rr <= b.r; rr++) for (var cc = a.c; cc <= b.c; cc++) {
          ws.getCell(rr, cc).border = { top: thin, left: thin, bottom: thin, right: thin };
        }
      }
    }
    function head(row, t) { put('A' + row + ':H' + row, t, { b: true, fill: GREY }); }
    var NB = { box: false };
    var typeIdx = { Annual: 1, Besar: 2, Sick: 3, Melahirkan: 4, Personal: 5, LuarTanggungan: 6 }[r.type] || 0;
    var tk = function (n) { return typeIdx === n ? '√' : ''; };
    var n = days(r.start, r.end);
    var tgl = new Date(r.createdAt).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
    var f = function (x) { return x || ''; };

    put('E1:H1', 'Kepada', NB); put('E2:H2', 'Yth. Kepala Distrik Navigasi Tipe B Tg. Priok', NB);
    put('E3:H3', 'di', NB); put('E4:H4', 'Jakarta', NB);
    put('A6:H6', 'FORMULIR PERMINTAAN DAN PEMBERIAN CUTI', { b: true, size: 12, h: 'center', box: false });
    put('A7:D7', 'NOMOR : ' + f(r.letterNumber), NB); put('E7:H7', 'TANGGAL : ' + tgl, NB);

    head(9, 'I. DATA PEGAWAI');
    put('A10', 'Nama', { b: true }); put('B10:D10', r.name); put('E10', 'NIP', { b: true }); put('F10:H10', f(r.nip));
    put('A11', 'Jabatan', { b: true }); put('B11:D11', f(r.jabatan)); put('E11', 'Masa Kerja', { b: true }); put('F11:H11', f(r.masa));
    put('A12', 'Unit Kerja', { b: true }); put('B12:H12', 'Distrik Navigasi Tipe B Tanjung Priok');

    head(14, 'II. JENIS CUTI YANG DIAMBIL**');
    put('A15:C15', '1. Cuti Tahunan'); put('D15', tk(1), { h: 'center', b: true }); put('E15:G15', '2. Cuti Besar'); put('H15', tk(2), { h: 'center', b: true });
    put('A16:C16', '3. Cuti Sakit'); put('D16', tk(3), { h: 'center', b: true }); put('E16:G16', '4. Cuti Melahirkan'); put('H16', tk(4), { h: 'center', b: true });
    put('A17:C17', '5. Cuti Karena Alasan Penting'); put('D17', tk(5), { h: 'center', b: true });
    put('E17:G17', '6. Cuti di Luar Tanggungan Negara'); put('H17', tk(6), { h: 'center', b: true });

    head(19, 'III. ALASAN CUTI');
    put('A20:H20', r.reason, { v: 'top' });

    head(22, 'IV. LAMANYA CUTI***');
    put('A23:C23', 'Selama  ' + n + '  (hari)*');
    put('D23:H23', 'Tanggal  ' + fmtDate(r.start) + '  s.d.  ' + fmtDate(r.end));

    head(25, 'V. CATATAN CUTI');
    var balForm = balanceForForm(r.nip, r);
    put('A26:D26', balForm.head, { b: true }); put('E26:G26', 'CUTI BESAR'); put('H26', '');
    put('A27', 'Tahun', { b: true, h: 'center' }); put('B27', 'Sisa', { b: true, h: 'center' }); put('C27:D27', 'Keterangan', { b: true, h: 'center' });
    put('E27:G27', 'CUTI SAKIT'); put('H27', '');
    var yrs = ['N-2', 'N-1', 'N'], rt = ['CUTI MELAHIRKAN', 'CUTI KARENA ALASAN PENTING', 'CUTI DILUAR TANGGUNGAN NEGARA'];
    for (var i = 0; i < 3; i++) {
      var rw = 28 + i;
      put('A' + rw, balForm.rows[i].y, { h: 'center' }); put('B' + rw, balForm.rows[i].s, { h: 'center', b: true }); put('C' + rw + ':D' + rw, balForm.rows[i].k);
      put('E' + rw + ':G' + rw, rt[i]); put('H' + rw, '');
    }

    head(32, 'VI. ALAMAT SELAMA MENJALANKAN CUTI');
    put('A33:E39', f(r.alamat), { v: 'top' });
    put('F33:H33', 'TELP : ' + f(r.telp));
    put('F34:H34', 'HORMAT SAYA,', { h: 'center', b: true });
    put('F35:H37', '');
    put('F38:H38', r.name, { h: 'center', b: true, u: true });
    put('F39:H39', 'NIP. ' + f(r.nip), { h: 'center' });
    if (r.sig) {
      var img = wb.addImage({ base64: r.sig, extension: 'png' });
      ws.addImage(img, { tl: { col: 5.4, row: 34.1 }, ext: { width: 200, height: 75 } });
    }

    function decision(top, title, ticks, role, nm, nip, note) {
      head(top, title);
      var lab = ['DISETUJUI', 'PERUBAHAN****', 'DITANGGUHKAN****', 'TIDAK DISETUJUI****'], cols = ['A:B', 'C:D', 'E:F', 'G:H'];
      for (var k = 0; k < 4; k++) {
        var cs = cols[k].split(':');
        put(cs[0] + (top + 1) + ':' + cs[1] + (top + 1), lab[k], { b: true, h: 'center' });
        put(cs[0] + (top + 2) + ':' + cs[1] + (top + 2), ticks[k] ? '√' : '', { b: true, h: 'center', size: 14 });
      }
      put('A' + (top + 3) + ':D' + (top + 8), note ? 'Catatan: ' + note : '', { size: 8, v: 'top' });
      put('E' + (top + 3) + ':H' + (top + 3), role, { h: 'center' });
      put('E' + (top + 4) + ':H' + (top + 6), '');
      put('E' + (top + 7) + ':H' + (top + 7), nm, { h: 'center', b: true, u: true });
      put('E' + (top + 8) + ':H' + (top + 8), nip, { h: 'center' });
    }
    decision(41, 'VII. PERSETUJUAN TAHAP 1**', [!!r.firstApprovedAt && r.firstDecision !== 'change', r.firstDecision === 'change', false, rejectedAtStage(r, 'first')],
      f(r.firstApproverPosition) || 'Penyetuju Tahap 1', f(r.firstApprover), 'NIP. ' + f(r.atasanNip), f(r.firstNote));
    decision(51, 'VIII. PERSETUJUAN TAHAP 2**', [!!r.secondApprovedAt, false, false, rejectedAtStage(r, 'second')],
      f(r.secondApproverPosition) || 'Penyetuju Tahap 2', f(r.secondApprover), '');
    put('A61:H61', 'Keterangan: tanda √ pada kotak menunjukkan pilihan.', { i: true, size: 8, box: false });

    [5, 8, 13, 18, 21, 24, 31, 40, 50].forEach(function (x) { ws.getRow(x).height = 5; });
    ws.getRow(17).height = 26; ws.getRow(20).height = 40;
    [35, 36, 37].forEach(function (x) { ws.getRow(x).height = 22; });
    [43, 53].forEach(function (x) { ws.getRow(x).height = 22; });
    [45, 46, 47, 55, 56, 57].forEach(function (x) { ws.getRow(x).height = 16; });
    /* Samakan rasio isi dengan area cetak A4 (margin 0.6" di semua sisi) agar pas penuh & simetris */
    var hs = [], cur = 0, i;
    for (i = 1; i <= 61; i++) { hs[i] = ws.getRow(i).height || 14; cur += hs[i]; }
    var widthPt = 8 * 72, target = widthPt * ((11.69 - 1.2) / (8.27 - 1.2)), k = target / cur;
    for (i = 1; i <= 61; i++) ws.getRow(i).height = Math.round(hs[i] * k * 100) / 100;
  }

  /* Unduh file. Di browser biasa memakai blob; di aplikasi Android (WebView) unduhan blob tidak jalan,
     jadi file diunggah ke Supabase Storage lalu dibuka lewat tautan https bertanda tangan (sementara). */
  function isAndroidWebView() {
    var ua = navigator.userAgent || '';
    return /Android/.test(ua) && (/; wv\)/.test(ua) || /Version\/\d/.test(ua));
  }
  function blobDownload(blob, fileName, okMsg) {
    var url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = fileName;
    document.body.appendChild(a); a.click(); a.remove();
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    if (okMsg) toast(okMsg);
  }
  function deliverFile(blob, fileName, mime, key, okMsg) {
    if (!isAndroidWebView() || !supabaseClient) { blobDownload(blob, fileName, okMsg); return; }
    var uid = (currentUser && currentUser.uid) || 'umum';
    var path = uid + '/' + String(key).replace(/[^A-Za-z0-9_.-]/g, '_') + '.' + fileName.split('.').pop();
    var bucket = supabaseClient.storage.from('surat-cuti');
    toast('Menyiapkan file...');
    bucket.upload(path, blob, { contentType: mime, upsert: true }).then(function (up) {
      if (up.error) throw up.error;
      return bucket.createSignedUrl(path, 600, { download: fileName });
    }).then(function (res) {
      if (res.error) throw res.error;
      toast(okMsg || 'File siap diunduh.');
      window.location.href = res.data.signedUrl;
    }).catch(function (error) {
      console.error('Unduhan lewat server gagal:', error);
      toast('File gagal disiapkan (' + (error.message || error.code || 'error') + '). Pastikan bucket surat-cuti sudah dibuat.');
    });
  }
  function exportBook(items) {
    if (!items.length) { toast('Tidak ada data untuk diekspor.'); return; }
    if (typeof ExcelJS === 'undefined') { toast('Library Excel gagal dimuat. Periksa koneksi internet.'); return; }
    var wb = new ExcelJS.Workbook(), used = {};
    items.forEach(function (r) {
      var nm = String(r.name || 'Cuti').replace(/[\\\/\?\*\[\]:]/g, '').slice(0, 24) || 'Cuti';
      var sn = nm, k = 2;
      while (used[sn]) { sn = nm + ' ' + k++; }
      used[sn] = 1;
      buildSheet(wb, sn, r);
    });
    wb.xlsx.writeBuffer().then(function (buf) {
      var xlsxName = items.length === 1 ? 'Formulir_Cuti_' + String(items[0].name).replace(/\s+/g, '_') + '.xlsx' : 'Formulir_Cuti_Semua.xlsx';
      deliverFile(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), xlsxName,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx_' + xlsxName, 'File Excel berhasil dibuat.');
    });
  }
  function nipForApproverName(name) {
    var key = String(name || '').trim().toLowerCase();
    if (!key) return '';
    var pools = [APPROVERS, ADMINS, CORRESPONDENCE, EMP.map(function (e) { return { name: e.n, nip: e.nip }; })];
    for (var i = 0; i < pools.length; i++) {
      var hit = pools[i].filter(function (p) { return String(p.name || '').trim().toLowerCase() === key; })[0];
      if (hit && hit.nip) return hit.nip;
    }
    return '';
  }
  function downloadEmployeePdf(id) {
    var user = activeUser();
    if (!user) { toast('Masuk ke akun untuk mengunduh surat.'); return; }
    var r = load().filter(function (item) { return item.id === id; })[0];
    if (!r) { toast('Surat tidak ditemukan.'); return; }
    if (r.status !== 'issued') { toast('PDF baru tersedia setelah surat diterbitkan Admin 1.'); return; }
    if (!canDownloadPdf(r)) { toast('PDF hanya dapat diunduh pemohon, Persuratan, dan Admin 1.'); return; }
    if (!window.jspdf || !window.jspdf.jsPDF) {
      toast('Library PDF gagal dimuat. Periksa koneksi internet lalu coba lagi.');
      return;
    }

    var doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    var pageWidth = 210, margin = 12, width = pageWidth - margin * 2, y = 10;
    var lineColor = [71, 85, 105], band = [231, 230, 230];
    function cell(x, top, w, h, text, options) {
      options = options || {};
      doc.setDrawColor.apply(doc, lineColor);
      doc.setLineWidth(0.2);
      doc.rect(x, top, w, h);
      if (options.fill) {
        doc.setFillColor.apply(doc, options.fill);
        doc.rect(x, top, w, h, 'F');
        doc.rect(x, top, w, h);
      }
      if (text === '' || text === null || text === undefined) return;
      doc.setFont('helvetica', options.bold ? 'bold' : 'normal');
      doc.setFontSize(options.size || 8);
      doc.setTextColor(15, 23, 42);
      var lines = doc.splitTextToSize(String(text), Math.max(4, w - 3));
      var lineHeight = (options.size || 8) * 0.42;
      var textY = options.valign === 'top' ? top + 4 : top + Math.max(3, (h - lines.length * lineHeight) / 2 + 2);
      doc.text(lines, x + 1.5, textY);
    }
    function section(title) {
      cell(margin, y, width, 6, title, { bold: true, fill: band, size: 8 });
      y += 6;
    }
    function signatureBlock(x, top, w, h, title, name, nip, signature, stamp) {
      cell(x, top, w, h, '', {});
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.setTextColor(15, 23, 42);
      doc.text(title, x + w / 2, top + 4, { align: 'center' });
      /* tanda tangan digambar: diperbesar semaksimal mungkin di area atas nama (tanpa garis tepi) */
      if (signature) {
        try {
          var props = doc.getImageProperties(signature);
          var areaW = w - 8, areaH = Math.max(8, h - 15);
          var sc = Math.min(areaW / props.width, areaH / props.height);
          var iw = props.width * sc, ih = props.height * sc;
          doc.addImage(signature, 'PNG', x + (w - iw) / 2, top + 5 + (areaH - ih) / 2, iw, ih);
        } catch (e) { console.error('Tanda tangan gagal dimasukkan ke PDF:', e); }
      }
      /* stempel kotak APPROVED di atas nama penyetuju */
      if (stamp) {
        var sw = 34, sh = 11, sx = x + (w - sw) / 2, sy = top + 6.5;
        doc.setDrawColor(22, 128, 60);
        doc.setTextColor(22, 128, 60);
        doc.setLineWidth(0.7);
        doc.roundedRect(sx, sy, sw, sh, 1, 1);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10);
        doc.text('APPROVED', x + w / 2, sy + 5.2, { align: 'center' });
        if (stamp.date) {
          doc.setFontSize(6);
          doc.text(new Date(stamp.date).toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric' }), x + w / 2, sy + 9, { align: 'center' });
        }
        doc.setLineWidth(0.2);
        doc.setDrawColor.apply(doc, lineColor);
        doc.setTextColor(15, 23, 42);
      }
      /* nama dan NIP: ukuran huruf sama, sejajar di tengah; mengecil bersama bila terlalu panjang */
      var nameText = String(name || ' '), nipText = String(nip || '');
      var size = 7;
      doc.setFont('helvetica', 'bold');
      while (size > 5 && (doc.setFontSize(size), doc.getTextWidth(nameText) > w - 4)) size -= 0.25;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(size);
      doc.text(nameText, x + w / 2, top + h - 7.5, { align: 'center' });
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(size);
      if (nipText) doc.text(nipText, x + w / 2, top + h - 3.5, { align: 'center' });
    }
    function decisionSection(top, title, labels, selected, role, name, nip, signature, note, stamp) {
      var sectionHeight = 48, col = width / 4;
      if (top + sectionHeight > 285) {
        doc.addPage();
        top = 12;
      }
      cell(margin, top, width, 6, title, { bold: true, fill: band, size: 8 });
      for (var i = 0; i < 4; i++) {
        var x = margin + i * col;
        cell(x, top + 6, col, 7, labels[i], { bold: true, size: 6 });
        cell(x, top + 13, col, 6, selected[i] ? 'X' : '', { bold: true, size: 10 });
      }
      cell(margin, top + 19, width / 2, sectionHeight - 19, 'CATATAN / PERTIMBANGAN', { size: 7, valign: 'top' });
      if (note) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7);
        doc.setTextColor(15, 23, 42);
        doc.text(doc.splitTextToSize(String(note), width / 2 - 5).slice(0, 6), margin + 2, top + 19 + 8.5);
      }
      signatureBlock(margin + width / 2, top + 19, width / 2, sectionHeight - 19, role, name, nip, signature, stamp);
      return top + sectionHeight;
    }
    var typeIdx = { Annual: 1, Besar: 2, Sick: 3, Melahirkan: 4, Personal: 5, LuarTanggungan: 6 }[r.type] || 0;
    var typeLabels = ['Cuti Tahunan', 'Cuti Besar', 'Cuti Sakit', 'Cuti Melahirkan', 'Cuti Karena Alasan Penting', 'Cuti di Luar Tanggungan Negara'];
    var dayCount = days(r.start, r.end);
    var createdDate = new Date(r.createdAt).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
    var cols = [width / 8, width * 3 / 8, width / 8, width * 3 / 8];

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.text('Kepada', margin + width * 0.62, y);
    y += 4;
    doc.text('Yth. Kepala Distrik Navigasi Tipe B Tg. Priok', margin + width * 0.62, y);
    y += 4;
    doc.text('di Jakarta', margin + width * 0.62, y);
    y += 5;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text('FORMULIR PERMINTAAN DAN PEMBERIAN CUTI', pageWidth / 2, y, { align: 'center' });
    y += 7;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.text('NOMOR : ' + (r.letterNumber || ''), margin, y);
    doc.text('TANGGAL : ' + createdDate, margin + width / 2, y);
    y += 5;

    section('I. DATA PEGAWAI');
    var fields = [
      ['Nama', r.name, 'NIP', r.nip],
      ['Jabatan', r.jabatan, 'Masa Kerja', r.masa],
      ['Unit Kerja', r.unit || 'Distrik Navigasi Tipe B Tanjung Priok', '', '']
    ];
    fields.forEach(function (row) {
      var rowHeight = 6;
      cell(margin, y, cols[0], rowHeight, row[0], { bold: true });
      cell(margin + cols[0], y, cols[1], rowHeight, row[1]);
      cell(margin + cols[0] + cols[1], y, cols[2], rowHeight, row[2], { bold: true });
      cell(margin + cols[0] + cols[1] + cols[2], y, cols[3], rowHeight, row[3]);
      y += rowHeight;
    });

    section('II. JENIS CUTI YANG DIAMBIL**');
    for (var tr = 0; tr < 3; tr++) {
      var leftIdx = tr * 2, rightIdx = leftIdx + 1, rowTop = y;
      cell(margin, rowTop, width * 0.42, 6, (leftIdx + 1) + '. ' + typeLabels[leftIdx], { size: 7 });
      cell(margin + width * 0.42, rowTop, width * 0.08, 6, typeIdx === leftIdx + 1 ? 'X' : '', { bold: true, size: 8 });
      cell(margin + width * 0.5, rowTop, width * 0.42, 6, (rightIdx + 1) + '. ' + typeLabels[rightIdx], { size: 7 });
      cell(margin + width * 0.92, rowTop, width * 0.08, 6, typeIdx === rightIdx + 1 ? 'X' : '', { bold: true, size: 8 });
      y += 6;
    }

    section('III. ALASAN CUTI');
    var reasonLines = doc.splitTextToSize(String(r.reason || '-'), width - 4);
    var reasonHeight = Math.max(10, reasonLines.length * 3.5 + 3);
    cell(margin, y, width, reasonHeight, '', {});
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.text(reasonLines, margin + 2, y + 4);
    y += reasonHeight;

    section('IV. LAMANYA CUTI***');
    cell(margin, y, width * 0.32, 7, 'Selama ' + dayCount + ' (hari)*');
    cell(margin + width * 0.32, y, width * 0.68, 7, 'Tanggal ' + fmtDate(r.start) + ' s.d. ' + fmtDate(r.end));
    y += 7;

    section('V. CATATAN CUTI');
    var half = width / 2;
    var balForm = balanceForForm(r.nip, r);
    cell(margin, y, half, 5, balForm.head, { bold: true, size: 7 });
    cell(margin + half, y, half, 5, 'CUTI LAINNYA', { bold: true, size: 7 });
    y += 5;
    cell(margin, y, half / 4, 5, 'Tahun', { bold: true, size: 7 });
    cell(margin + half / 4, y, half / 4, 5, 'Sisa', { bold: true, size: 7 });
    cell(margin + half / 2, y, half / 2, 5, 'Keterangan', { bold: true, size: 7 });
    cell(margin + half, y, half, 5, 'Jenis cuti / keterangan', { bold: true, size: 7 });
    y += 5;
    balForm.rows.forEach(function (row) {
      cell(margin, y, half / 4, 5, row.y, { size: 7 });
      cell(margin + half / 4, y, half / 4, 5, row.s, { size: 8, bold: true });
      cell(margin + half / 2, y, half / 2, 5, row.k, { size: 7 });
      cell(margin + half, y, half, 5, typeIdx > 1 ? typeLabels[typeIdx - 1] : '', { size: 7 });
      y += 5;
    });

    section('VI. ALAMAT SELAMA MENJALANKAN CUTI');
    var addressHeight = 38;
    cell(margin, y, width * 0.62, addressHeight, r.alamat || '', { valign: 'top' });
    cell(margin + width * 0.62, y, width * 0.38, 7, 'TELP : ' + (r.telp || ''));
    signatureBlock(margin + width * 0.62, y + 7, width * 0.38, addressHeight - 7,
      'HORMAT SAYA,', r.name, 'NIP. ' + (r.nip || ''), r.sig);
    y += addressHeight;

    var decisionLabels = ['DISETUJUI', 'PERUBAHAN****', 'DITANGGUHKAN****', 'TIDAK DISETUJUI****'];
    y = decisionSection(y, 'VII. PERSETUJUAN TAHAP 1**', decisionLabels,
      [!!r.firstApprovedAt && r.firstDecision !== 'change', r.firstDecision === 'change', false, rejectedAtStage(r, 'first')],
      r.firstApproverPosition || 'Penyetuju Tahap 1', r.firstApprover, 'NIP. ' + (r.atasanNip || nipForApproverName(r.firstApprover) || ''), null, r.firstNote || '', r.firstApprovedAt ? { date: r.firstApprovedAt } : null);
    y = decisionSection(y, 'VIII. PERSETUJUAN TAHAP 2**', decisionLabels,
      [!!r.secondApprovedAt, false, false, rejectedAtStage(r, 'second')],
      r.secondApproverPosition || 'Penyetuju Tahap 2', r.secondApprover, nipForApproverName(r.secondApprover) ? 'NIP. ' + nipForApproverName(r.secondApprover) : '', null, '', r.secondApprovedAt ? { date: r.secondApprovedAt } : null);
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(7);
    doc.text('Keterangan: tanda X pada kotak menunjukkan pilihan. Ruang kosong di atas nama disediakan untuk tanda tangan.', margin, Math.min(y + 4, 288));
    var filename = String(r.name || 'Pemohon').replace(/[\\\/:*?"<>|]/g, '').trim().replace(/\s+/g, '_') || 'Pemohon';
    deliverFile(doc.output('blob'), 'Surat_Cuti_' + filename + '.pdf', 'application/pdf', 'surat_' + r.id, 'PDF surat cuti berhasil diunduh.');
  }
  document.getElementById('btn-all').addEventListener('click', function () {
    if (!canExportExcel()) { toast('Hanya Admin 1 yang dapat mengekspor Excel.'); return; }
    exportBook(load());
  });

  /* ---------- Actions (event delegation) ---------- */
  function update(id, expectedStatus, fn, msg, authorize) {
    var list = load();
    var found = false;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) {
        found = true;
        if (list[i].status !== expectedStatus) {
          renderAll();
          toast('Status pengajuan sudah berubah. Muat ulang antrean sebelum memprosesnya.');
          return false;
        }
        if (authorize && !authorize(list[i])) {
          renderAll();
          toast('Tugas ini tidak ditugaskan kepada petugas yang sedang masuk.');
          return false;
        }
        fn(list[i]);
        break;
      }
    }
    if (!found) { toast('Pengajuan tidak ditemukan.'); return false; }
    if (!save(list)) return false;
    renderAll();
    toast(msg);
    return true;
  }
  document.querySelectorAll('.admin-tab').forEach(function (b) {
    b.addEventListener('click', function () { adminTab = b.dataset.tab; renderAdmin(); });
  });
  document.getElementById('btn-exp-approved').addEventListener('click', function () {
    if (!canExportExcel()) { toast('Hanya Admin 1 yang dapat mengekspor Excel.'); return; }
    exportBook(load().filter(function (r) { return r.status === 'issued'; }));
  });
  var requestEditModal = document.getElementById('request-edit-modal');
  function closeRequestEditModal(fromPop) {
    if (!requestEditModal.classList.contains('hidden')) {
      requestEditModal.classList.add('hidden');
      requestEditModal.classList.remove('flex');
      if (!fromPop && history.state && history.state.modal === 'edit') {
        try { history.back(); } catch (e) {}
      }
    }
  }
  function fillApproverSelect(select, selectedName, allowEmpty) {
    select.innerHTML = (allowEmpty ? '<option value="">Tidak ada</option>' : '<option value="">Pilih penyetuju...</option>') +
      APPROVERS.map(function (person) {
        return '<option value="' + esc(person.nip) + '">' + esc(person.name) + '</option>';
      }).join('');
    var selected = approverByNip(
      (APPROVERS.filter(function (person) { return person.name === selectedName; })[0] || {}).nip || ''
    );
    if (selected) select.value = selected.nip;
    else if (selectedName) {
      select.insertAdjacentHTML('beforeend', '<option value="' + esc(selectedName) + '">' + esc(selectedName) + ' (data pengajuan)</option>');
      select.value = selectedName;
    } else select.value = '';
  }
  function openRequestEditModal(id) {
    if (!isAdmin1()) { toast('Hanya Admin 1 yang dapat mengedit data pengajuan.'); return; }
    var request = load().filter(function (item) { return item.id === id; })[0];
    if (!request || request.status !== 'pending_direct') {
      toast('Pengajuan hanya dapat diedit sebelum diproses penyetuju tahap 1.');
      renderAll();
      return;
    }
    document.getElementById('request-edit-id').value = request.id;
    document.getElementById('request-edit-name').value = request.name || '';
    document.getElementById('request-edit-nip').value = request.nip || '';
    document.getElementById('request-edit-jabatan').value = request.jabatan || '';
    document.getElementById('request-edit-masa').value = request.masa || '';
    document.getElementById('request-edit-unit').value = request.unit || '';
    document.getElementById('request-edit-type').value = request.type || 'Annual';
    document.getElementById('request-edit-start').value = request.start || '';
    document.getElementById('request-edit-end').value = request.end || '';
    document.getElementById('request-edit-telp').value = request.telp || '';
    document.getElementById('request-edit-alamat').value = request.alamat || '';
    document.getElementById('request-edit-reason').value = request.reason || '';
    fillApproverSelect(document.getElementById('request-edit-approver1'), request.firstApprover, false);
    fillApproverSelect(document.getElementById('request-edit-approver2'), request.secondApprover, true);
    document.getElementById('request-edit-error').classList.add('hidden');
    requestEditModal.classList.remove('hidden');
    requestEditModal.classList.add('flex');
    try { history.pushState({ modal: 'edit', view: (history.state && history.state.view) || 'home' }, ''); } catch (e) {}
  }
  document.getElementById('request-edit-cancel').addEventListener('click', function () { closeRequestEditModal(); });
  requestEditModal.addEventListener('click', function (event) {
    if (event.target === requestEditModal) closeRequestEditModal();
  });
  document.getElementById('request-edit-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var error = document.getElementById('request-edit-error');
    error.classList.add('hidden');
    var id = document.getElementById('request-edit-id').value;
    var start = document.getElementById('request-edit-start').value;
    var end = document.getElementById('request-edit-end').value;
    if (end < start) {
      error.textContent = 'Tanggal selesai tidak boleh sebelum tanggal mulai.';
      error.classList.remove('hidden');
      return;
    }
    var firstValue = document.getElementById('request-edit-approver1').value;
    var secondValue = document.getElementById('request-edit-approver2').value;
    var first = approverByNip(firstValue);
    var second = approverByNip(secondValue);
    var updated = update(id, 'pending_direct', function (request) {
      request.name = document.getElementById('request-edit-name').value.trim();
      request.nip = document.getElementById('request-edit-nip').value.trim();
      request.requestedBy = request.nip;
      request.jabatan = document.getElementById('request-edit-jabatan').value.trim();
      request.masa = document.getElementById('request-edit-masa').value.trim();
      request.unit = document.getElementById('request-edit-unit').value.trim();
      request.type = document.getElementById('request-edit-type').value;
      request.start = start;
      request.end = end;
      request.telp = document.getElementById('request-edit-telp').value.trim();
      request.alamat = document.getElementById('request-edit-alamat').value.trim();
      request.reason = document.getElementById('request-edit-reason').value.trim();
      request.firstApprover = first ? first.name : firstValue;
      request.firstApproverPosition = first ? first.title : '';
      request.secondApprover = second ? second.name : (secondValue || '');
      request.secondApproverPosition = second ? second.title : '';
      request.atasan = request.firstApprover;
      request.atasanNip = first ? first.nip : '';
    }, 'Data pengajuan berhasil diperbarui.', function () {
      return isAdmin1();
    });
    if (updated) {
      closeRequestEditModal();
      showView('admin');
    }
  });
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-action]');
    if (!b) return;
    var id = b.dataset.id;
    switch (b.dataset.action) {
      case 'save-social-links':
        if (!canManageAdmin2Settings()) { toast('Hanya Admin 2 yang dapat mengubah tautan media sosial.'); break; }
        var nextSocialLinks = {}, invalidSocialLink = false;
        SOCIAL_SITES.forEach(function (site) {
          var input = document.getElementById('admin2-social-' + site.id);
          var value = input.value.trim();
          var url = normalizeSocialUrl(value);
          if (value && (!input.checkValidity() || !url)) {
            input.reportValidity();
            invalidSocialLink = true;
          }
          nextSocialLinks[site.id] = url;
        });
        if (invalidSocialLink) {
          toast('Gunakan tautan lengkap yang diawali http:// atau https://.');
          break;
        }
        try {
          localStorage.setItem(SOCIAL_LINKS_KEY, JSON.stringify(nextSocialLinks));
        } catch (error) {
          console.error('Tautan media sosial tidak dapat disimpan:', error);
        }
        socialLinks = nextSocialLinks;
        /* Pulihkan sesi lokal agar user tetap bisa keluar-masuk Beranda tanpa login ulang */
  try {
    var cached = restoreSessionUser();
    if (cached && !currentUser) {
      currentUser = cached;
    }
  } catch(e){}

  renderSocialLinks();
        var socialStatusEl = document.getElementById('admin2-social-status');
        socialStatusEl.textContent = 'Menyimpan ke server...';
        pushSetting('social_links', nextSocialLinks).then(function (ok) {
          if (ok) {
            socialStatusEl.className = 'text-sm text-green-700';
            socialStatusEl.textContent = 'Tautan berhasil disimpan dan tampil di semua perangkat.';
            toast('Tautan media sosial berhasil disimpan.');
          } else {
            socialStatusEl.className = 'text-sm text-red-700';
            socialStatusEl.textContent = 'GAGAL tersimpan ke server. Tautan hanya ada di perangkat ini.';
          }
        });
        break;
      case 'admin-edit-request':
        openRequestEditModal(id);
        break;
      case 'save-approver':
      case 'save-staff-name':
        if (!canManageAdmin2Settings()) { toast('Hanya Admin 2 yang dapat mengubah data petugas.'); break; }
        var svRole = b.dataset.role || 'approver';
        var svOldNip = b.dataset.nip;
        var svPerson = findStaffByRoleAndNip(svRole, svOldNip) || approverByNip(svOldNip);
        var svNameInput = document.querySelector('.staff-name[data-role="' + svRole + '"][data-nip="' + svOldNip + '"]')
          || document.querySelector('.approver-name[data-nip="' + svOldNip + '"]');
        var svNipInput = document.querySelector('.staff-nip[data-role="' + svRole + '"][data-nip="' + svOldNip + '"]');
        var svNextName = svNameInput ? svNameInput.value.trim() : '';
        var svNextNip = svNipInput ? svNipInput.value.trim().replace(/\s+/g, ' ') : svOldNip;
        if (!svPerson || !svNextName || !svNextNip) {
          toast('Nama dan NIP petugas wajib diisi.');
          break;
        }
        var svOldName = svPerson.name;
        var svNipChanged = svNextNip.replace(/\s/g, '') !== svOldNip.replace(/\s/g, '');
        if (svNipChanged) {
          var svNipKey = svNextNip.replace(/\s/g, '');
          var svAllStaff = APPROVERS.concat(ADMINS, CORRESPONDENCE);
          var svDup = svAllStaff.some(function (p) {
            return p !== svPerson && p.nip.replace(/\s/g, '') === svNipKey;
          });
          if (svDup) { toast('NIP tersebut sudah digunakan petugas lain.'); break; }
        }
        supabaseClient.rpc('admin_update_staff', {
          p_role: svRole,
          p_old_nip: svOldNip,
          p_name: svNextName,
          p_nip: svNextNip
        }).then(function (result) {
          if (result.error) throw result.error;
          var requestsUpdated = svRole !== 'approver' ||
            updateApproverNameReferences(svOldName, svNextName, svOldNip, svNextNip);
          directoryLoaded = false;
          return loadDirectoryFromServer().then(function () {
            renderAll();
            toast(requestsUpdated
              ? 'Data petugas berhasil diperbarui.'
              : 'Data petugas tersimpan, tetapi antrean pengajuan belum diperbarui.');
          });
        }).catch(function (error) {
          console.error('Data petugas gagal diperbarui:', error);
          toast('Data petugas gagal diperbarui (' + (error.code || error.message || 'error') + ').');
        });
        break;
      case 'delete-staff':
        if (!canManageAdmin2Settings()) { toast('Hanya Admin 2 yang dapat menghapus petugas.'); break; }
        var dlRole = b.dataset.role;
        var dlNip = b.dataset.nip;
        var dlRoleConfig = additionalStaffRoles[dlRole];
        if (!dlRoleConfig) break;
        var dlKey = String(dlNip).replace(/\s/g, '');
        var dlPerson = dlRoleConfig.list.filter(function (person) {
          return person.nip.replace(/\s/g, '') === dlKey;
        })[0];
        if (!dlPerson || dlRoleConfig.additions.indexOf(dlPerson) === -1) {
          toast('Petugas data bawaan tidak dapat dihapus.');
          break;
        }
        if (!confirm('Hapus ' + dlRoleConfig.label + ' "' + dlPerson.name + '" dari daftar?')) break;
        supabaseClient.rpc('admin_delete_staff', { p_role: dlRole, p_nip: dlNip })
          .then(function (result) {
            if (result.error) throw result.error;
            if (testUser && testUser.nip === dlNip) stopTestMode();
            directoryLoaded = false;
            return loadDirectoryFromServer();
          }).then(function () {
            renderAll();
            toast(dlRoleConfig.label + ' berhasil dihapus.');
          }).catch(function (error) {
            console.error('Data petugas gagal dihapus:', error);
            toast('Petugas gagal dihapus (' + (error.code || error.message || 'error') + ').');
          });
        break;
      case 'password-reset':
        if (!canManageAdmin2Settings()) { toast('Hanya Admin 2 yang dapat meminta reset password.'); break; }
        var resetApprover = approverByNip(id);
        if (!supabaseClient || !resetApprover || !resetApprover.email) {
          toast('Alamat email Supabase penyetuju belum tersedia.');
          break;
        }
        supabaseClient.auth.resetPasswordForEmail(resetApprover.email, { redirectTo: window.location.href.split('#')[0] }).then(function (result) {
          if (result.error) throw result.error;
          toast('Tautan reset password dikirim ke ' + resetApprover.email + '.');
        }).catch(function (error) {
          console.error('Pengiriman tautan reset password gagal:', error);
          toast(authErrorMessage(error));
        });
        break;
      case 'export':
        if (!canExportExcel()) { toast('Hanya Admin 1 yang dapat mengekspor Excel.'); break; }
        exportBook(load().filter(function (r) { return r.id === id; })); break;
      case 'view-attach':
        openAttachModal(id); break;
      case 'employee-pdf':
        downloadEmployeePdf(id); break;
      case 'first-approve':
        openFirstDecisionModal(id);
        break;
      case 'first-reject':
        var firstRejectingUser = activeUser();
        var firstRejReq = load().filter(function (r) { return r.id === id; })[0];
        if (update(id, 'pending_direct', function (r) {
          r.status = 'rejected'; r.rejectedBy = firstRejectingUser.name; r.rejectedStage = 'first'; r.rejectedAt = Date.now();
        }, 'Pengajuan ditolak pada tahap 1.', function (r) {
          return firstRejectingUser && firstRejectingUser.role === 'approver' && r.firstApprover === firstRejectingUser.name;
        })) {
          if (firstRejReq) {
            notifyApplicant(firstRejReq, 'Pengajuan ditolak',
              'Pengajuan cuti Anda ditolak oleh ' + firstRejectingUser.name + ' (Tahap 1).');
          }
        }
        break;
      case 'second-approve':
        var secondApproverUser = activeUser();
        var secondReq = load().filter(function (r) { return r.id === id; })[0];
        if (update(id, 'pending_next', function (r) {
          r.status = 'pending_correspondence';
          r.secondApprovedAt = Date.now();
          r.secondApprovedBy = secondApproverUser.name;
        }, 'Persetujuan tahap 2 selesai dan diteruskan ke Persuratan.', function (r) {
          return secondApproverUser && secondApproverUser.role === 'approver' && r.secondApprover === secondApproverUser.name;
        })) {
          showView('approver');
          if (secondReq) {
            notifyApplicant(secondReq, 'Pengajuan disetujui',
              'Pengajuan cuti Anda telah disetujui dan diteruskan ke Persuratan untuk nomor surat.');
            CORRESPONDENCE.forEach(function (c) {
              notifyByNip(c.nip, 'Pengajuan menunggu nomor surat',
                'Pengajuan cuti dari ' + secondReq.name + ' menunggu penerbitan nomor surat.');
            });
          }
        }
        break;
      case 'second-reject':
        var secondRejectingUser = activeUser();
        var secondRejReq = load().filter(function (r) { return r.id === id; })[0];
        if (update(id, 'pending_next', function (r) {
          r.status = 'rejected'; r.rejectedBy = secondRejectingUser.name; r.rejectedStage = 'second'; r.rejectedAt = Date.now();
        }, 'Pengajuan ditolak pada tahap 2.', function (r) {
          return secondRejectingUser && secondRejectingUser.role === 'approver' && r.secondApprover === secondRejectingUser.name;
        })) {
          if (secondRejReq) {
            notifyApplicant(secondRejReq, 'Pengajuan ditolak',
              'Pengajuan cuti Anda ditolak oleh ' + secondRejectingUser.name + ' (Tahap 2).');
          }
        }
        break;
      case 'edit-draft':
        if (typeof window.editDraft === 'function') window.editDraft(id);
        break;
      case 'send-draft':
        if (typeof window.sendDraft === 'function') window.sendDraft(id);
        break;
      case 'delete-draft':
        if (confirm('Hapus draft ini?')) { var l = load().filter(function(x){ return x.id !== id; }); if (save(l)) { renderAll(); toast('Draft dihapus.'); } }
        break;
      case 'cancel-request':
        if (confirm('Batalkan pengajuan ini?')) { var ll = load().filter(function(x){ return x.id !== id; }); if (save(ll)) { renderAll(); toast('Pengajuan dibatalkan.'); } }
        break;
      case 'correspondence-issue-number':
        openLetterNumberModal(id);
        break;
      case 'admin-issue':
        var issuingAdmin = activeUser();
        if (!issuingAdmin || issuingAdmin.role !== 'admin' || issuingAdmin.nip !== ADMINS[0].nip) {
          toast('Hanya Admin 1 yang dapat menerbitkan surat.');
          break;
        }
        var readyForIssue = load().filter(function (r) { return r.id === id; })[0];
        if (!readyForIssue || !readyForIssue.letterNumber) {
          toast('Nomor surat dari Persuratan belum tersedia.');
          break;
        }
        if (update(id, 'pending_admin_issue', function (r) {
          r.status = 'issued';
          r.issuedAt = Date.now();
          r.issuedBy = issuingAdmin && issuingAdmin.role === 'admin' ? issuingAdmin.name : 'Admin';
          r.letterDeliveredAt = Date.now();
          r.letterDeliveredTo = r.requestedBy || r.nip;
        }, 'Surat diterbitkan dan PDF tersedia di riwayat akun pemohon.', function () {
          return issuingAdmin && issuingAdmin.role === 'admin';
        })) {
          notifyApplicant(readyForIssue, 'Surat cuti diterbitkan',
            'Surat cuti Anda (No. ' + readyForIssue.letterNumber + ') telah diterbitkan. Unduh PDF di riwayat pengajuan.');
        }
        break;
    }
  });

  /* ---------- Reset ---------- */
  document.getElementById('btn-reset').addEventListener('click', function () {
    if (!isAdmin1Or2()) { toast('Hanya Admin 1 dan Admin 2 yang dapat menghapus data.'); return; }
    if (confirm('Hapus semua data pengajuan cuti?') && save([])) { renderAll(); toast('Semua data dihapus.'); }
  });



  /* ---------- Tombol kembali HP: pindah halaman di dalam aplikasi ---------- */
  function getActiveModal() {
    var np = document.getElementById('notif-panel');
    if (np && !np.classList.contains('hidden')) return 'notif';
    var lm = document.getElementById('letter-number-modal');
    if (lm && !lm.classList.contains('hidden')) return 'letter';
    var rm = document.getElementById('request-edit-modal');
    if (rm && !rm.classList.contains('hidden')) return 'edit';
    return null;
  }
  function closeModalDirect(name) {
    if (name === 'notif') closeNotifPanel(true);
    else if (name === 'letter') closeLetterNumberModal(true);
    else if (name === 'edit') closeRequestEditModal(true);
  }

  window.addEventListener('popstate', function (e) {
    var openModal = getActiveModal();
    if (openModal) {
      closeModalDirect(openModal);
      return;
    }

    var state = e.state || {};
    var v = state.view || 'home';
    var sub = state.sub || 'menu';

    // Jika sudah logout dan target view adalah halaman yang membutuhkan login,
    // paksa ke beranda agar aplikasi tidak terlihat "mati" atau restart.
    if (!activeUser() && v !== 'home' && v !== 'login') {
      try { history.replaceState({ view: 'home', sub: 'menu' }, ''); } catch (err) {}
      v = 'home';
      sub = 'menu';
    }

    navFromPop = true;
    showView(v);
    if (v === 'employee') {
      empShow(sub, true);
    }
    navFromPop = false;
  });

  window.addEventListener('pageshow', function () {
    var state = history.state || {};
    var v = state.view || 'home';
    var sub = state.sub || 'menu';
    navFromPop = true;
    showView(v);
    if (v === 'employee') {
      empShow(sub, true);
    }
    navFromPop = false;
    safeRender();
  });

  try { history.replaceState({ view: 'home', sub: 'menu' }, ''); } catch (e) {}

  /* ---------- Buka tautan media sosial secara aman ---------- */
  document.addEventListener('click', function (e) {
    var a = e.target.closest('#home-social-links a[href]');
    if (!a) return;
    var href = a.getAttribute('href');
    if (!href) return;
    e.preventDefault();
    try {
      var w = window.open(href, '_blank', 'noopener,noreferrer');
      if (!w || w.closed || typeof w.closed === 'undefined') {
        var link = document.createElement('a');
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      }
    } catch (err) {
      window.open(href, '_blank');
    }
  });

  /* ---------- Init ---------- */
  /* Pulihkan sesi lokal agar user tetap bisa keluar-masuk Beranda tanpa login ulang */
  try {
    var cached = restoreSessionUser();
    if (cached && !currentUser) {
      currentUser = cached;
    }
  } catch(e){}

  renderSocialLinks();
  fillSocialLinkInputs();
  showView('home');
  loadSocialLinksFromServer();
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) {
      loadSocialLinksFromServer();
      safeRender();
    }
  });
})();