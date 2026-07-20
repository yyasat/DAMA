    /* ── 主题切换 ── */
    const _mq = window.matchMedia('(prefers-color-scheme: light)');
    let _currentTheme = 'light';

    function applyScheme(scheme) {
        if (scheme === 'light') document.documentElement.setAttribute('data-theme', 'light');
        else document.documentElement.removeAttribute('data-theme');
    }

    function setTheme(theme) {
        _currentTheme = theme;
        ['dark','light','system'].forEach(t => {
            const el = document.getElementById('t-' + t);
            if (el) el.classList.toggle('active', t === theme);
        });
        try { localStorage.setItem('dama_theme', theme); } catch(e) {}
        applyScheme(theme === 'system' ? (_mq.matches ? 'light' : 'dark') : theme);
        closeThemePopup();
    }

    function toggleThemePopup(e) {
        if (e) e.stopPropagation();
        document.getElementById('theme-popup').classList.toggle('open');
    }
    function closeThemePopup() {
        document.getElementById('theme-popup').classList.remove('open');
    }
    document.addEventListener('click', function(e) {
        const popup = document.getElementById('theme-popup');
        const btn = document.getElementById('btn-theme');
        if (popup.classList.contains('open') && !popup.contains(e.target) && e.target !== btn) {
            closeThemePopup();
        }
    });

    _mq.addEventListener('change', e => {
        if (_currentTheme === 'system') applyScheme(e.matches ? 'light' : 'dark');
    });

    // 初始化主题（页面加载时读取上次设置）
    (function() {
        let saved = 'light';
        try { saved = localStorage.getItem('dama_theme') || 'light'; } catch(e) {}
        setTheme(saved);
    })();

    const canvas   = document.getElementById('canvas');
    const ctx      = canvas.getContext('2d', { willReadFrequently: true });
    const wmCanvas = document.getElementById('wm-canvas');
    const wmCtx    = wmCanvas.getContext('2d');
    const emptyEl  = document.getElementById('empty-state');
    const toastEl  = document.getElementById('toast');

    let originalImage = null;
    let isDrawing     = false;
    let currentMode   = 'pan';
    let startX = 0, startY = 0;
    let snapshot = null;
    let historyStack = [];
    let historyStep  = -1;
    let movingZoneIndex = -1;
    let zoneStartPos    = null;
    let resizingZoneIndex = -1;  // 正在拖动缩放的禁止层下标
    let resizeCorner      = null; // 当前拖动的是哪个角：nw/ne/sw/se
    let resizeAnchor      = null; // 缩放时固定不动的对角坐标
    
    // 水印图层状态（独立于主画布，随时可根据禁止层重新计算，不需要"烘焙"进图片）
    let isWmMode = false;          // 是否正打开水印设置面板
    let watermarkOn = false;       // 水印图层当前是否显示
    let watermarkConfirmed = false;// 是否已经点过"确定应用"（用于取消时判断要不要恢复无水印）

    // 多图队列
    let imageQueue   = [];   // { dataUrl, editedData }
    let currentIndex = -1;

    /* ── 手动缩放/平移视图 ── */
    const canvasWrap = document.getElementById('canvas-wrap');
    let viewScale = 1, viewX = 0, viewY = 0;
    const VIEW_MIN = 1, VIEW_MAX = 6;
    let pinchActive = false, pinchStartDist = 0, pinchStartScale = 1, pinchLastMid = null;
    let panActive = false, panStart = null, panOrigView = null;
    let lastTapTime = 0, lastTapX = 0, lastTapY = 0;

    function applyView() {
        canvasWrap.style.transform = `translate(${viewX}px, ${viewY}px) scale(${viewScale})`;
    }
    function resetView() {
        viewScale = 1; viewX = 0; viewY = 0;
        applyView();
    }
    function zoomTo(newScale, clientX, clientY) {
        newScale = Math.min(VIEW_MAX, Math.max(VIEW_MIN, newScale));
        const rect = canvasWrap.getBoundingClientRect();
        const lx = (clientX - rect.left) / viewScale;
        const ly = (clientY - rect.top) / viewScale;
        viewX += lx * (viewScale - newScale);
        viewY += ly * (viewScale - newScale);
        viewScale = newScale;
        if (viewScale <= 1.001) { viewScale = 1; viewX = 0; viewY = 0; }
        applyView();
    }
    function dist(t0, t1) { return Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY); }
    function midpoint(t0, t1) { return { x: (t0.clientX + t1.clientX) / 2, y: (t0.clientY + t1.clientY) / 2 }; }

    function cancelActiveDraw() {
        if (isDrawing && currentMode === 'box' && snapshot) ctx.putImageData(snapshot, 0, 0);
        isDrawing = false;
        movingZoneIndex = -1;
        resizingZoneIndex = -1;
        drawZoneOverlay();
    }

    function beginPinch(e) {
        if (e.cancelable) e.preventDefault();
        cancelActiveDraw();
        panActive = false;
        pinchActive = true;
        pinchStartDist = dist(e.touches[0], e.touches[1]);
        pinchStartScale = viewScale;
        pinchLastMid = midpoint(e.touches[0], e.touches[1]);
    }
    function updatePinch(e) {
        if (e.touches.length < 2) return;
        if (e.cancelable) e.preventDefault();
        const d = dist(e.touches[0], e.touches[1]);
        const mid = midpoint(e.touches[0], e.touches[1]);
        const newScale = pinchStartScale * (d / pinchStartDist);
        zoomTo(newScale, mid.x, mid.y);
        viewX += mid.x - pinchLastMid.x;
        viewY += mid.y - pinchLastMid.y;
        pinchLastMid = mid;
        applyView();
    }

    function beginViewPan(e) {
        if (e.cancelable) e.preventDefault();
        panActive = true;
        const p = e.touches ? e.touches[0] : e;
        panStart = { x: p.clientX, y: p.clientY };
        panOrigView = { x: viewX, y: viewY };
    }
    function updateViewPan(e) {
        if (e.cancelable) e.preventDefault();
        const p = e.touches ? e.touches[0] : e;
        viewX = panOrigView.x + (p.clientX - panStart.x);
        viewY = panOrigView.y + (p.clientY - panStart.y);
        applyView();
    }

    document.getElementById('workspace').addEventListener('wheel', function(e) {
        if (!originalImage) return;
        if (!(e.ctrlKey || e.metaKey)) return; // 触控板双指捏合会自动带上 ctrlKey；普通滚轮需按住 Ctrl/⌘ 才缩放，避免影响正常滚动
        e.preventDefault();
        const factor = Math.exp(-e.deltaY * 0.0015);
        zoomTo(viewScale * factor, e.clientX, e.clientY);
    }, { passive: false });

    /* ── Toast ── */
    let _toastTimer;
    function showToast(msg, duration = 2200) {
        clearTimeout(_toastTimer);
        toastEl.textContent = msg;
        toastEl.style.opacity = '1';
        _toastTimer = setTimeout(() => { toastEl.style.opacity = '0'; }, duration);
    }

    /* ── 禁止层（水印排除区） ── */
    let excludeZones = [];  // [{x, y, w, h}, ...]

    function drawZoneOverlay(preview) {
        const svg = document.getElementById('zone-svg');
        if (!svg || !canvas.width) return;
        svg.setAttribute('viewBox', `0 0 ${canvas.width} ${canvas.height}`);
        const sw = Math.max(4, canvas.width / 200);
        const da = `${Math.max(12, canvas.width / 55)} ${Math.max(7, canvas.width / 90)}`;
        const fs = Math.max(24, canvas.width / 22);

        let html = excludeZones.map(z => {
            const lx = Math.min(z.x, z.x + z.w);
            const ly = Math.min(z.y, z.y + z.h);
            const lw = Math.abs(z.w);
            const lh = Math.abs(z.h);
            const hr = Math.max(6, canvas.width / 160);
            const hsw = Math.max(1.5, canvas.width / 500);
            const handles = [[lx,ly],[lx+lw,ly],[lx,ly+lh],[lx+lw,ly+lh]].map(([hx,hy]) =>
                `<circle cx="${hx}" cy="${hy}" r="${hr}" fill="#e05555" stroke="#fff" stroke-width="${hsw}"/>`
            ).join('');
            return `<g>
                <rect x="${lx}" y="${ly}" width="${lw}" height="${lh}"
                      fill="rgba(210,55,55,0.13)" stroke="#e05555" stroke-width="${sw}"
                      stroke-dasharray="${da}"/>
                <text x="${lx + lw/2}" y="${ly + lh/2}" font-size="${fs}"
                      fill="rgba(220,60,60,0.65)" text-anchor="middle"
                      dominant-baseline="middle" font-family="Jost,sans-serif">✕</text>
                ${handles}
            </g>`;
        }).join('');

        if (preview) {
            const lx = Math.min(preview.x, preview.x + preview.w);
            const ly = Math.min(preview.y, preview.y + preview.h);
            const lw = Math.abs(preview.w);
            const lh = Math.abs(preview.h);
            html += `<rect x="${lx}" y="${ly}" width="${lw}" height="${lh}"
                           fill="rgba(210,55,55,0.08)" stroke="#e05555"
                           stroke-width="${sw}" stroke-dasharray="${da}" opacity="0.55"/>`;
        }
        svg.innerHTML = html;
        updateZoneUI();
    }

    function updateZoneUI() {
        const infoRow  = document.getElementById('zone-info-row');
        const countEl  = document.getElementById('zone-count');
        const tipEl    = document.getElementById('zone-tip');
        if (!infoRow) return;
        const show = (currentMode === 'zone' || excludeZones.length > 0);
        infoRow.style.display = show ? 'flex' : 'none';
        if (countEl) countEl.textContent = `${excludeZones.length} 个禁止层`;
        if (tipEl)   tipEl.style.display = currentMode === 'zone' ? 'inline' : 'none';
    }

    function addZone(x, y, w, h) {
        if (Math.abs(w) < 10 || Math.abs(h) < 10) return;
        excludeZones.push({ x, y, w, h });
        drawZoneOverlay();
        if (watermarkOn) drawRealTimeWatermark();
        showToast(`已新增禁止层，共 ${excludeZones.length} 个`);
        saveState();
    }

        function getZoneAt(px, py) {
        for (let i = excludeZones.length - 1; i >= 0; i--) {
            const z = excludeZones[i];
            const lx = Math.min(z.x, z.x + z.w);
            const ly = Math.min(z.y, z.y + z.h);
            const lw = Math.abs(z.w), lh = Math.abs(z.h);
            if (px >= lx && px <= lx + lw && py >= ly && py <= ly + lh) {
                return i;
            }
        }
        return -1;
    }

    // 判断是否点中了某个禁止层四角的缩放手柄，返回 {index, corner} 或 null
    function getZoneHandleAt(px, py) {
        const hitR = Math.max(16, canvas.width / 40);
        for (let i = excludeZones.length - 1; i >= 0; i--) {
            const z = excludeZones[i];
            const lx = Math.min(z.x, z.x + z.w);
            const ly = Math.min(z.y, z.y + z.h);
            const lw = Math.abs(z.w), lh = Math.abs(z.h);
            const corners = {
                nw: { x: lx,      y: ly },
                ne: { x: lx + lw, y: ly },
                sw: { x: lx,      y: ly + lh },
                se: { x: lx + lw, y: ly + lh },
            };
            for (const corner in corners) {
                const c = corners[corner];
                if (Math.hypot(px - c.x, py - c.y) <= hitR) {
                    return { index: i, corner };
                }
            }
        }
        return null;
    }

    function clearZones() {
        excludeZones = [];
        drawZoneOverlay();
        if (watermarkOn) drawRealTimeWatermark();
        showToast("已清除全部禁止层");
        saveState();
    }

    /* ── 统一撤销管理 ── */
    function saveState() {
        // 在操作完成后保存画布快照
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
        // 同时保存当前的所有禁止层状态，确保撤销时位置也是对的
        const zones = JSON.parse(JSON.stringify(excludeZones));
        
        historyStack = historyStack.slice(0, historyStep + 1);
        historyStack.push({ imgData: data, zones: zones });
        historyStep++;
        
        // 限制历史记录数量，防止内存爆炸
        if (historyStack.length > 20) {
            historyStack.shift();
            historyStep--;
        }
        updateUndoRedoUI();
    }

    function updateUndoRedoUI() {
        const undoBtn = document.getElementById('btn-undo');
        const redoBtn = document.getElementById('btn-redo');
        if (undoBtn) undoBtn.disabled = historyStep <= 0;
        if (redoBtn) redoBtn.disabled = historyStep >= historyStack.length - 1;
    }

    function undo() {
        if (historyStep > 0) {
            historyStep--;
            const state = historyStack[historyStep];
            ctx.putImageData(state.imgData, 0, 0);
            excludeZones = JSON.parse(JSON.stringify(state.zones));
            drawZoneOverlay(); // 刷新层级显示
            if (watermarkOn) drawRealTimeWatermark();
            updateUndoRedoUI();
            showToast("已撤销");
        } else {
            showToast("已回到初始状态");
        }
    }
    function redo() {
        if (historyStep < historyStack.length - 1) {
            historyStep++;
            const state = historyStack[historyStep];
            ctx.putImageData(state.imgData, 0, 0);
            excludeZones = JSON.parse(JSON.stringify(state.zones));
            drawZoneOverlay();
            if (watermarkOn) drawRealTimeWatermark();
            updateUndoRedoUI();
            showToast("已重做");
        }
    }

    /* ── 模式切换 ── */
    function switchMode(mode) {
        currentMode = mode;
        // 清空上一次可能残留的拖拽/移动/缩放状态，避免出现"幽灵"禁止层预览框
        isDrawing = false;
        movingZoneIndex = -1;
        resizingZoneIndex = -1;
        ['pan','box','brush','zone'].forEach(m => {
            const el = document.getElementById('mode-' + m);
            if (el) el.classList.remove('active');
        });
        document.getElementById('mode-' + mode).classList.add('active');
        const labels = { pan: "浏览模式", box: "拉框打码模式", brush: "涂抹打码模式", zone: "禁止层模式 — 空白拖拽新增，拖拽移动，拖角缩放，原地点击删除" };
        showToast(labels[mode] || "");
        drawZoneOverlay(); // 清除任何残留的预览框
        updateZoneUI();
    }

    /* ── 底部工具栏折叠 ── */
    function toggleBottomPanel() {
        const panel = document.getElementById('bottom-collapsible');
        const arrow = document.getElementById('collapse-arrow');
        const collapsed = panel.classList.toggle('collapsed');
        arrow.textContent = collapsed ? '﹀' : '︿';
        try { localStorage.setItem('dama_panel_collapsed', collapsed ? '1' : '0'); } catch(e) {}
    }
    (function() {
        let collapsed = false;
        try { collapsed = localStorage.getItem('dama_panel_collapsed') === '1'; } catch(e) {}
        if (collapsed) {
            document.getElementById('bottom-collapsible').classList.add('collapsed');
            document.getElementById('collapse-arrow').textContent = '﹀';
        }
    })();

    /* ── 多图队列 ── */
    document.getElementById('upload').addEventListener('change', function(e) {
        const files = Array.from(e.target.files);
        if (!files.length) return;
        let loaded = 0;
        const startIdx = imageQueue.length;
        files.forEach(file => {
            const reader = new FileReader();
            reader.onload = ev => {
                imageQueue.push({ dataUrl: ev.target.result, editedData: null });
                loaded++;
                if (loaded === files.length) {
                    loadImageAtIndex(startIdx);
                    showToast(`已加入 ${files.length} 张，共 ${imageQueue.length} 张`);
                }
            };
            reader.readAsDataURL(file);
        });
        e.target.value = '';
    });

    function saveCurrentEdits() {
        if (currentIndex >= 0 && originalImage && canvas.width > 0)
            imageQueue[currentIndex].editedData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    }

    function loadImageAtIndex(index) {
        if (index < 0 || index >= imageQueue.length) return;
        saveCurrentEdits();
        currentIndex = index;
        const item = imageQueue[index];
        const img = new Image();
        img.onload = () => {
            originalImage = img;
            canvas.width  = img.width;
            canvas.height = img.height;
            wmCanvas.width  = img.width;
            wmCanvas.height = img.height;
            if (item.editedData) {
                ctx.putImageData(item.editedData, 0, 0);
                historyStack = [{ imgData: item.editedData, zones: [] }];
                historyStep  = 0;
            } else {
                ctx.drawImage(img, 0, 0);
                historyStack = []; historyStep = -1;
                saveState();
            }
            emptyEl.style.display = 'none';
            canvas.style.display  = 'block';
            wmCanvas.style.display = 'block';
            updateNavUI();
            updateUndoRedoUI();
            switchMode('pan');
            resetView();
            if (watermarkOn) drawRealTimeWatermark();
            document.getElementById('workspace').scrollTop = 0;
        };
        img.src = item.dataUrl;
    }

    function prevImage() { loadImageAtIndex(currentIndex - 1); }
    function nextImage() { loadImageAtIndex(currentIndex + 1); }

    function deleteCurrentImage() {
        if (currentIndex < 0 || imageQueue.length === 0) return showToast("没有图片可删除");
        imageQueue.splice(currentIndex, 1);

        if (imageQueue.length === 0) {
            currentIndex = -1;
            originalImage = null;
            excludeZones = [];
            historyStack = []; historyStep = -1;
            watermarkOn = false; watermarkConfirmed = false; isWmMode = false;
            document.getElementById('wm-setting-row').style.display = 'none';
            canvas.style.display = 'none';
            wmCanvas.style.display = 'none';
            emptyEl.style.display = 'flex';
            updateNavUI();
            updateUndoRedoUI();
            drawZoneOverlay();
            resetView();
            showToast("已删除，暂无图片");
            return;
        }

        const nextIdx = Math.min(currentIndex, imageQueue.length - 1);
        currentIndex = -1; // 强制 loadImageAtIndex 重新加载，跳过 saveCurrentEdits 覆盖已删除数据
        loadImageAtIndex(nextIdx);
        showToast(`已删除，剩余 ${imageQueue.length} 张`);
    }

    function updateNavUI() {
        const nav    = document.getElementById('img-nav');
        const count  = document.getElementById('img-counter');
        const bPrev  = document.getElementById('btn-prev');
        const bNext  = document.getElementById('btn-next');
        const bAll   = document.getElementById('btn-export-all');

        if (imageQueue.length > 0) {
            nav.classList.add('on');
            const cur   = String(currentIndex + 1).padStart(2, '0');
            const total = String(imageQueue.length).padStart(2, '0');
            count.textContent   = `${cur} / ${total}`;
            bPrev.disabled      = currentIndex <= 0;
            bNext.disabled      = currentIndex >= imageQueue.length - 1;
            bAll.style.display  = imageQueue.length > 1 ? 'inline' : 'none';
        } else {
            nav.classList.remove('on');
            bAll.style.display = 'none';
        }
    }

    /* ── 批量导出（逐个下载） ── */
    async function exportAll() {
        if (imageQueue.length === 0) return showToast("没有图片可导出");
        saveCurrentEdits();

        const overlay  = document.getElementById('export-overlay');
        const bar      = document.getElementById('export-bar');
        const subLabel = document.getElementById('export-sub');
        overlay.classList.add('show');

        try {
            for (let i = 0; i < imageQueue.length; i++) {
                const item = imageQueue[i];
                subLabel.textContent = `正在导出 ${i + 1} / ${imageQueue.length}`;
                bar.style.width = `${((i) / imageQueue.length) * 100}%`;

                const tc  = document.createElement('canvas');
                const tcx = tc.getContext('2d');
                if (item.editedData) {
                    tc.width  = item.editedData.width;
                    tc.height = item.editedData.height;
                    tcx.putImageData(item.editedData, 0, 0);
                } else {
                    const img2 = await new Promise(res => {
                        const t = new Image(); t.onload = () => res(t); t.src = item.dataUrl;
                    });
                    tc.width  = img2.width;
                    tc.height = img2.height;
                    tcx.drawImage(img2, 0, 0);
                }
                // 水印是独立图层，只对当前正在查看/编辑的这张图叠加实时水印效果
                if (i === currentIndex && watermarkOn) {
                    tcx.drawImage(wmCanvas, 0, 0, tc.width, tc.height);
                }
                
                const blob = await new Promise(res => tc.toBlob(res, 'image/png', 1.0));
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = `dama_${String(i+1).padStart(2,'0')}.png`;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                URL.revokeObjectURL(url);

                await new Promise(res => setTimeout(res, 300));
            }

            bar.style.width = '100%';
            subLabel.textContent = '导出完成';
            showToast(`✓ 已逐个导出 ${imageQueue.length} 张图片`);
        } catch(err) {
            showToast("导出失败，请重试");
            console.error(err);
        } finally {
            setTimeout(() => {
                overlay.classList.remove('show');
                bar.style.width = '0%';
            }, 500);
        }
    }

    /* ── 单张导出 ── */
    function exportImage() {
        if (!originalImage) return showToast("还没有导入图片");
        const tc = document.createElement('canvas');
        tc.width = canvas.width; tc.height = canvas.height;
        const tcx = tc.getContext('2d');
        tcx.drawImage(canvas, 0, 0);
        if (watermarkOn) tcx.drawImage(wmCanvas, 0, 0);
        const link = document.createElement('a');
        link.download = `dama_${String(currentIndex+1).padStart(2,'0')}.png`;
        link.href = tc.toDataURL('image/png', 1.0);
        link.click();
        showToast("✓ 导出成功");
    }

    /* ── 模糊核心 ── */
    function applyBlurToRect(rx, ry, rw, rh) {
        const xS = Math.max(0, Math.min(rx, rx+rw));
        const yS = Math.max(0, Math.min(ry, ry+rh));
        const xE = Math.min(canvas.width,  Math.max(rx, rx+rw));
        const yE = Math.min(canvas.height, Math.max(ry, ry+rh));
        const w  = xE-xS, h = yE-yS;
        if (w<=0||h<=0) return;

        const blurR = parseInt(document.getElementById('blur-radius').value);
        const pad   = blurR*2;
        const sx    = Math.max(0, xS-pad),   sy = Math.max(0, yS-pad);
        const sw    = Math.min(canvas.width, xE+pad)-sx;
        const sh    = Math.min(canvas.height,yE+pad)-sy;

        const tc  = document.createElement('canvas');
        tc.width  = sw; tc.height = sh;
        tc.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);

        ctx.save();
        ctx.beginPath(); ctx.rect(xS, yS, w, h); ctx.clip();
        ctx.filter = `blur(${blurR}px)`;
        ctx.drawImage(tc, sx, sy);
        ctx.restore();
    }

    /* ── 坐标换算 ── */
    function getEventPos(e) {
        const rect  = canvas.getBoundingClientRect();
        const scaleX = canvas.width  / rect.width;
        const scaleY = canvas.height / rect.height;
        const cX = e.touches?.length ? e.touches[0].clientX : e.clientX;
        const cY = e.touches?.length ? e.touches[0].clientY : e.clientY;
        return { x: (cX - rect.left)*scaleX, y: (cY - rect.top)*scaleY };
    }

    /* ── 绘图事件 ── */
    function handleStart(e) {
        if (!originalImage) return;
        if (e.touches && e.touches.length >= 2) { beginPinch(e); return; }

        // 已放大时，原地双击/双触可复位到 100%
        if (viewScale > 1.001) {
            const now = Date.now();
            const p = e.touches ? e.touches[0] : e;
            if (now - lastTapTime < 350 && Math.hypot(p.clientX - lastTapX, p.clientY - lastTapY) < 30) {
                resetView();
                lastTapTime = 0;
                return;
            }
            lastTapTime = now; lastTapX = p.clientX; lastTapY = p.clientY;
        }

        if (currentMode === 'pan') {
            if (viewScale > 1.001) beginViewPan(e);
            return;
        }
        // 水印编辑模式下，只允许继续调整禁止层，其余模式（拉框/涂抹）仍然屏蔽
        if (isWmMode && currentMode !== 'zone') return;
        if (e.cancelable) e.preventDefault();
        isDrawing = true;
        const pos = getEventPos(e);
        startX = pos.x; startY = pos.y;
        
        if (currentMode === 'box') {
            snapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);
        } else if (currentMode === 'zone') {
            const handle = getZoneHandleAt(pos.x, pos.y);
            if (handle) {
                const z = excludeZones[handle.index];
                z.x = Math.min(z.x, z.x + z.w);
                z.y = Math.min(z.y, z.y + z.h);
                z.w = Math.abs(z.w);
                z.h = Math.abs(z.h);
                // 缩放时固定的是被拖动角的对角
                const anchors = {
                    nw: { x: z.x + z.w, y: z.y + z.h },
                    ne: { x: z.x,       y: z.y + z.h },
                    sw: { x: z.x + z.w, y: z.y },
                    se: { x: z.x,       y: z.y },
                };
                resizingZoneIndex = handle.index;
                resizeCorner = handle.corner;
                resizeAnchor = anchors[handle.corner];
                movingZoneIndex = -1;
            } else {
                resizingZoneIndex = -1;
                const zIdx = getZoneAt(pos.x, pos.y);
                if (zIdx !== -1) {
                    movingZoneIndex = zIdx;
                    let z = excludeZones[zIdx];
                    z.x = Math.min(z.x, z.x + z.w);
                    z.y = Math.min(z.y, z.y + z.h);
                    z.w = Math.abs(z.w);
                    z.h = Math.abs(z.h);
                    zoneStartPos = { x: pos.x, y: pos.y, origX: z.x, origY: z.y };
                } else {
                    movingZoneIndex = -1;
                }
            }
        } else {
            const sz = parseInt(document.getElementById('blur-radius').value)*3;
            applyBlurToRect(pos.x-sz/2, pos.y-sz/2, sz, sz);
        }
    }
    
    function handleMove(e) {
        if (pinchActive) { updatePinch(e); return; }
        if (panActive) { updateViewPan(e); return; }
        if (!isDrawing || currentMode === 'pan') return;
        if (isWmMode && currentMode !== 'zone') return;
        if (e.cancelable) e.preventDefault();
        const pos = getEventPos(e);
        
        if (currentMode === 'box') {
            ctx.putImageData(snapshot, 0, 0);
            ctx.save();
            ctx.strokeStyle = 'rgba(201,169,108,0.85)';
            ctx.lineWidth   = Math.max(3, canvas.width/350);
            ctx.setLineDash([8,6]);
            ctx.strokeRect(startX, startY, pos.x-startX, pos.y-startY);
            ctx.restore();
        } else if (currentMode === 'zone') {
            if (resizingZoneIndex !== -1) {
                const z = excludeZones[resizingZoneIndex];
                z.x = resizeAnchor.x;
                z.y = resizeAnchor.y;
                z.w = pos.x - resizeAnchor.x;
                z.h = pos.y - resizeAnchor.y;
                drawZoneOverlay();
                if (watermarkOn) drawRealTimeWatermark();
            } else if (movingZoneIndex !== -1) {
                const dx = pos.x - zoneStartPos.x;
                const dy = pos.y - zoneStartPos.y;
                excludeZones[movingZoneIndex].x = zoneStartPos.origX + dx;
                excludeZones[movingZoneIndex].y = zoneStartPos.origY + dy;
                drawZoneOverlay();
                if (watermarkOn) drawRealTimeWatermark();
            } else {
                const preview = { x: startX, y: startY, w: pos.x - startX, h: pos.y - startY };
                drawZoneOverlay(preview);
                if (watermarkOn) drawRealTimeWatermark(preview);
            }
        } else {
            const sz = parseInt(document.getElementById('blur-radius').value)*3;
            applyBlurToRect(pos.x-sz/2, pos.y-sz/2, sz, sz);
        }
    }
    
    function handleEnd(e) {
        if (pinchActive) {
            if (!e.touches || e.touches.length < 2) pinchActive = false;
            return;
        }
        if (panActive) { panActive = false; return; }
        if (!isDrawing || currentMode === 'pan') return;
        if (isWmMode && currentMode !== 'zone') return;
        isDrawing = false;
        
        if (currentMode === 'box') {
            ctx.putImageData(snapshot, 0, 0);
            const pos = getEventPos(e.changedTouches ? e.changedTouches[0] : e);
            applyBlurToRect(startX, startY, pos.x-startX, pos.y-startY);
            saveState();
        } else if (currentMode === 'zone') {
            const pos = getEventPos(e.changedTouches ? e.changedTouches[0] : e);
            
            if (resizingZoneIndex !== -1) {
                const z = excludeZones[resizingZoneIndex];
                const nx = Math.min(z.x, z.x + z.w);
                const ny = Math.min(z.y, z.y + z.h);
                const nw = Math.abs(z.w);
                const nh = Math.abs(z.h);
                if (nw < 10 || nh < 10) {
                    excludeZones.splice(resizingZoneIndex, 1);
                    showToast("禁止层太小，已删除");
                } else {
                    z.x = nx; z.y = ny; z.w = nw; z.h = nh;
                    showToast("已调整禁止层大小");
                }
                resizingZoneIndex = -1;
                drawZoneOverlay();
                if (watermarkOn) drawRealTimeWatermark();
                saveState();
            } else if (movingZoneIndex !== -1) {
                const dx = pos.x - zoneStartPos.x;
                const dy = pos.y - zoneStartPos.y;
                if (Math.abs(dx) < 5 && Math.abs(dy) < 5) {
                    excludeZones.splice(movingZoneIndex, 1);
                    showToast(`已删除禁止层，剩余 ${excludeZones.length} 个`);
                }
                movingZoneIndex = -1;
                drawZoneOverlay();
                if (watermarkOn) drawRealTimeWatermark(); // 禁止层变化后，水印实时铺满空出的区域
                saveState();
            } else {
                const w = pos.x - startX, h = pos.y - startY;
                if (Math.abs(w) >= 10 || Math.abs(h) >= 10) {
                    addZone(startX, startY, w, h);
                } else {
                    drawZoneOverlay();
                    if (watermarkOn) drawRealTimeWatermark();
                }
            }
        } else {
            saveState();
        }
    }

    canvas.addEventListener('mousedown',  handleStart);
    window.addEventListener('mousemove',  handleMove);
    window.addEventListener('mouseup',    handleEnd);
    canvas.addEventListener('touchstart', handleStart, {passive:false});
    canvas.addEventListener('touchmove',  handleMove,  {passive:false});
    window.addEventListener('touchend',   handleEnd,   {passive:false});

        /* ── 水印 (支持自定义，独立图层实时渲染) ── */
    function toggleWmMode() {
        if (!originalImage) return showToast("请先导入图片");
        isWmMode = true;
        watermarkOn = true;
        document.getElementById('wm-setting-row').style.display = 'flex';
        drawRealTimeWatermark();
        showToast("水印已实时显示，移动/增删禁止层会自动跟随");
    }

    function hexToRgba(hex, alpha) {
        hex = hex.replace('#', '');
        let r = parseInt(hex.substring(0, 2), 16);
        let g = parseInt(hex.substring(2, 4), 16);
        let b = parseInt(hex.substring(4, 6), 16);
        return `rgba(${r},${g},${b},${alpha})`;
    }

    // extraZone: 正在拖拽新建、尚未真正加入 excludeZones 的预览框，传入后水印会临时也跳过这块区域
    function drawRealTimeWatermark(extraZone) {
        if (!wmCanvas.width) return;
        wmCtx.clearRect(0, 0, wmCanvas.width, wmCanvas.height);
        if (!watermarkOn) return;

        const text = document.getElementById('wm-text').value || "仅供展示 禁止盗图";
        const color = document.getElementById('wm-color').value;
        const opacity = document.getElementById('wm-opacity').value;
        const density = document.getElementById('wm-density').value;

        const fs = Math.max(16, Math.floor(wmCanvas.width/24));
        wmCtx.save();

        // 用禁止层区域挖空裁剪区，让水印跳过这些区域
        const zones = extraZone ? [...excludeZones, extraZone] : excludeZones;
        if (zones.length > 0) {
            wmCtx.beginPath();
            wmCtx.rect(0, 0, wmCanvas.width, wmCanvas.height);
            zones.forEach(z => {
                const lx = Math.min(z.x, z.x + z.w);
                const ly = Math.min(z.y, z.y + z.h);
                const lw = Math.abs(z.w), lh = Math.abs(z.h);
                wmCtx.rect(lx, ly, lw, lh);
            });
            wmCtx.clip('evenodd');
        }

        wmCtx.font = `bold ${fs}px 'Jost', sans-serif`;
        wmCtx.fillStyle = hexToRgba(color, opacity);
        wmCtx.translate(wmCanvas.width/2, wmCanvas.height/2);
        wmCtx.rotate(-30*Math.PI/180);
        
        const diag = Math.sqrt(wmCanvas.width**2 + wmCanvas.height**2);
        const stepX = wmCtx.measureText(text).width + Math.max(20, 80 / density);
        const stepY = fs * Math.max(1.5, 4 / density);
        
        for (let i = -diag; i < diag; i += stepX) {
            for (let j = -diag; j < diag; j += stepY) {
                wmCtx.fillText(text, i, j);
            }
        }
        wmCtx.restore();
    }

    function confirmWatermark() {
        if (!isWmMode) return;
        isWmMode = false;
        watermarkConfirmed = true;
        document.getElementById('wm-setting-row').style.display = 'none';
        showToast("✓ 水印已应用，之后调整禁止层会自动实时更新");
    }

    function cancelWatermark() {
        if (!isWmMode) return;
        isWmMode = false;
        document.getElementById('wm-setting-row').style.display = 'none';
        // 如果之前从未真正确认应用过，取消则完全去掉水印；否则保留上一次已确认的水印效果
        watermarkOn = watermarkConfirmed;
        drawRealTimeWatermark();
        showToast(watermarkOn ? "已放弃本次修改" : "已取消水印");
    }
