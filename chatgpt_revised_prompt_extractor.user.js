// ==UserScript==
// @name         ChatGPT 图片生成优化提示词提取器
// @namespace    https://github.com/kadevin/chatgpt-revised-prompt
// @version      5.3.0
// @description  手动提取 ChatGPT 图片生成优化提示词 + 提示词库管理与快捷填入
// @author       iLab
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @require      https://cdn.jsdelivr.net/npm/jszip@3/dist/jszip.min.js
// @license      MIT
// ==/UserScript==
(function () {
'use strict';

// ============================================================
// Section 1: Configuration & Logging
// ============================================================
const DEBUG = true;
function log(...a) { if (DEBUG) console.log('%c[GPT Suite]', 'color:#10a37f;font-weight:bold', ...a); }

const Config = {
    STORAGE_KEY: 'promptManager.prompts',
    CATEGORIES_KEY: 'promptManager.categories',
    PANEL_ID: 'gpt-panel',
    FAB_ID: 'gpt-fab',
    VERSION: '1.0.5',
    DEFAULT_CATEGORIES: ['通用模板', '人物描述', '风格', '构图', '光影与质感', '负面提示词', '文字与签名'],
};

function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ============================================================
// Section 2: Storage Service
// ============================================================
const StorageService = {
    async load() {
        return (await GM_getValue(Config.STORAGE_KEY)) || [];
    },
    async save(prompts) {
        await GM_setValue(Config.STORAGE_KEY, prompts);
    },
    async loadCategories() {
        const stored = await GM_getValue(Config.CATEGORIES_KEY);
        if (stored && Array.isArray(stored)) return stored;
        // First load: migrate from DEFAULT_CATEGORIES
        await GM_setValue(Config.CATEGORIES_KEY, [...Config.DEFAULT_CATEGORIES]);
        return [...Config.DEFAULT_CATEGORIES];
    },
    async saveCategories(cats) {
        await GM_setValue(Config.CATEGORIES_KEY, cats);
    },
    exportJSON(prompts) {
        const data = { app: 'Prompt Manager', schemaVersion: 1, exportedAt: new Date().toISOString(), prompts };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `prompt-manager-${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        URL.revokeObjectURL(url);
    },
    async importJSON(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const data = JSON.parse(reader.result);
                    if (!data.prompts || !Array.isArray(data.prompts)) { reject(new Error('无效的提示词备份文件')); return; }
                    resolve(data.prompts);
                } catch(e) { reject(new Error('文件解析失败')); }
            };
            reader.onerror = () => reject(new Error('文件读取失败'));
            reader.readAsText(file);
        });
    },
};

// ============================================================
// Section 3: Prompt Service
// ============================================================
const PromptService = {
    create(data) {
        return {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            title: data.title || '',
            content: data.content || '',
            category: data.category || '通用模板',
            tags: data.tags || [],
            favorite: false,
            usageCount: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
    },
    update(prompt, data) {
        return { ...prompt, ...data, updatedAt: new Date().toISOString() };
    },
    search(keyword, prompts) {
        if (!keyword) return prompts;
        const kw = keyword.toLowerCase();
        return prompts.filter(p =>
            p.title.toLowerCase().includes(kw) ||
            p.content.toLowerCase().includes(kw) ||
            (p.tags || []).some(t => t.toLowerCase().includes(kw))
        );
    },
    filterByCategory(category, prompts) {
        if (!category || category === '全部') return prompts;
        return prompts.filter(p => p.category === category);
    },
    sortByRecent(prompts) {
        return [...prompts].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    },
};

// ============================================================
// Section 3.5: Template Variable Functions
// ============================================================
function parseTemplate(template) {
    const matches = template.match(/\{([^{}]+)\}/g);
    if (!matches) return [];
    return [...new Set(matches.map(m => {
        const inner = m.slice(1, -1);
        const eqIdx = inner.indexOf('=');
        return eqIdx > -1 ? inner.slice(0, eqIdx) : inner;
    }))];
}

function parseArgs(text) {
    const named = {};
    const positional = [];
    // Match: name='value' or name="value" (named), 'value' (positional), '' (skip)
    const re = /([\w一-鿿㐀-䶿]+)=(['"])((?:(?!\2).)*)\2|'(([^']*)?)'/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        if (m[1]) {
            named[m[1]] = m[3];
        } else {
            positional.push(m[4] === '' ? '__SKIP__' : m[4]);
        }
    }
    return { named, positional };
}

function fillTemplate(template, named, positional) {
    // 1. Parse all placeholders
    const placeholders = [];
    template.replace(/\{([^{}]+)\}/g, (fullMatch, inner) => {
        const eqIdx = inner.indexOf('=');
        placeholders.push({
            full: fullMatch,
            varName: eqIdx > -1 ? inner.slice(0, eqIdx) : inner,
            defaultVal: eqIdx > -1 ? inner.slice(eqIdx + 1).replace(/^['"]|['"]$/g, '') : null
        });
        return '';
    });
    // 2. Build value map: skip markers leave variables unfilled
    const valueMap = {};
    let posIdx = 0;
    for (const ph of placeholders) {
        if (ph.varName in named) {
            valueMap[ph.varName] = named[ph.varName];
        } else if (posIdx < positional.length) {
            if (positional[posIdx] === '__SKIP__') {
                posIdx++;
            } else {
                valueMap[ph.varName] = positional[posIdx++];
            }
        }
    }
    // 3. Replace
    return template.replace(/\{([^{}]+)\}/g, (fullMatch, inner) => {
        const eqIdx = inner.indexOf('=');
        const varName = eqIdx > -1 ? inner.slice(0, eqIdx) : inner;
        if (varName in valueMap) return valueMap[varName];
        if (eqIdx > -1) {
            const defaultVal = inner.slice(eqIdx + 1).replace(/^['"]|['"]$/g, '');
            if (defaultVal) return defaultVal;
        }
        return fullMatch;
    });
}

function readArgsFromEditor() {
    const ev = SiteAdapter.getEditorView();
    if (!ev) return { named: {}, positional: [] };
    const text = ev.state.doc.textContent;
    const args = parseArgs(text);
    // Clear the editor after reading args
    try {
        const tr = ev.state.tr.delete(0, ev.state.doc.content.size);
        ev.props.dispatchTransaction.call(ev, tr);
    } catch(e) {}
    return args;
}

// ============================================================
// Section 4: Site Adapter (ProseMirror Insertion)
// ============================================================
const SiteAdapter = {
    _editorView: null,

    _findEditorView() {
        // Use unsafeWindow to get real DOM element with __reactFiber keys
        const pm = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).document.getElementById('prompt-textarea');
        if (!pm) return null;
        const pmParent = pm.parentElement;
        if (!pmParent) return null;
        const fiberKey = Object.keys(pmParent).find(k => k.startsWith('__reactFiber'));
        if (!fiberKey) return null;

        // Walk to React root fiber
        let root = pmParent[fiberKey];
        let walkSteps = 0;
        while (root.return && walkSteps < 5000) { root = root.return; walkSteps++; }

        // DFS from root: check every component's hooks for the ProseMirror EditorView
        // (ChatGPT minified component names change across deployments)
        const stack = [root];
        let iter = 0;
        while (stack.length > 0 && iter < 20000) {
            iter++;
            const fiber = stack.pop();
            if (!fiber) continue;

            let hook = fiber.memoizedState;
            let hookIdx = 0;
            while (hook && hookIdx < 20) {
                const ms = hook.memoizedState;
                if (ms && typeof ms === 'object' && ms.state && ms.dispatch) return ms;
                hook = hook.next;
                hookIdx++;
            }

            if (fiber.sibling) stack.push(fiber.sibling);
            if (fiber.child) stack.push(fiber.child);
        }
        return null;
    },

    getEditorView() {
        if (this._editorView && this._editorView.dom?.isConnected) return this._editorView;
        this._editorView = this._findEditorView();
        return this._editorView;
    },

    insertText(text, mode = 'append') {
        const ev = this.getEditorView();
        if (!ev) return false;
        try {
            const schema = ev.state.schema;
            const lines = text.split('\n');
            const newParagraphs = lines.map(line =>
                line === '' ? schema.nodes.paragraph.create() : schema.nodes.paragraph.create(null, schema.text(line))
            );
            let tr;
            if (mode === 'append' && ev.state.doc.content.size > 2) {
                const endPos = ev.state.doc.content.size - 1;
                tr = ev.state.tr.insert(endPos, newParagraphs);
            } else {
                const content = schema.nodes.doc.create(null, newParagraphs);
                tr = ev.state.tr.replaceWith(0, ev.state.doc.content.size, content.content);
            }
            ev.props.dispatchTransaction.call(ev, tr);
            return true;
        } catch(e) { log('insertText error:', e); return false; }
    },

    clearInput() {
        const ev = this.getEditorView();
        if (!ev) return false;
        try {
            const tr = ev.state.tr.delete(0, ev.state.doc.content.size);
            ev.props.dispatchTransaction.call(ev, tr);
            return true;
        } catch(e) { return false; }
    },
};

// ============================================================
// Section 5: Token & API Layer
// ============================================================
let _cachedToken = null;
let _tokenExpiry = 0;

function getConversationId() {
    const m = location.pathname.match(/\/c\/([a-f0-9-]+)/);
    return m ? m[1] : null;
}

function getAccessToken() {
    try {
        const doc = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).document;
        const el = doc.getElementById('client-bootstrap');
        if (el) {
            const d = JSON.parse(el.textContent);
            const t = d?.accessToken || d?.session?.accessToken || null;
            if (t) { _cachedToken = t; _tokenExpiry = Date.now() + 8 * 60 * 1000; return t; }
        }
    } catch(e) {}
    if (_cachedToken && Date.now() < _tokenExpiry) return _cachedToken;
    return null;
}

async function refreshAccessToken() {
    try {
        log('刷新 access token...');
        const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        const resp = await win.fetch('https://chatgpt.com/api/auth/session', { credentials: 'include' });
        if (resp.ok) {
            const data = await resp.json();
            const t = data?.accessToken;
            if (t) { _cachedToken = t; _tokenExpiry = Date.now() + 8 * 60 * 1000; log('Token 已刷新'); return t; }
        }
    } catch(e) { log('刷新 token 失败:', e.message); }
    return null;
}

// ============================================================
// Section 6: Extraction Engine
// ============================================================
let allRounds = [];
const seenPrompts = new Set();
let lastFetchTime = 0;
let lastFetchConvId = '';
const FETCH_COOLDOWN = 5000;
let isFetchingPrompts = false;
let _userUploadedFileIds = new Set();

function getOrderedPath(mapping) {
    const childrenOf = {};
    for (const [id, node] of Object.entries(mapping)) {
        const pid = node.parent;
        if (pid) { if (!childrenOf[pid]) childrenOf[pid] = []; childrenOf[pid].push(id); }
    }
    for (const pid of Object.keys(childrenOf)) {
        childrenOf[pid].sort((a, b) => {
            const ta = mapping[a]?.message?.create_time || 0;
            const tb = mapping[b]?.message?.create_time || 0;
            return ta - tb;
        });
    }
    const root = Object.keys(mapping).find(id => !mapping[id].parent);
    if (!root) return Object.keys(mapping);
    const path = [];
    const visited = new Set();
    const stack = [root];
    while (stack.length > 0) {
        const cur = stack.pop();
        if (visited.has(cur)) continue;
        visited.add(cur);
        path.push(cur);
        const ch = childrenOf[cur] || [];
        for (let i = ch.length - 1; i >= 0; i--) stack.push(ch[i]);
    }
    path.sort((a, b) => (mapping[a]?.message?.create_time || 0) - (mapping[b]?.message?.create_time || 0));
    return path;
}

function extractImageUrlsFromParts(parts, excludeFileIds = _userUploadedFileIds) {
    const urls = [];
    const fileIds = [];
    for (const part of parts) {
        if (!part || typeof part !== 'object') continue;
        if (part.asset_pointer && typeof part.asset_pointer === 'string') {
            const fid = part.asset_pointer.replace('file-service://', '');
            if (fid) fileIds.push(fid);
        }
        if (typeof part.url === 'string' && part.url.startsWith('http')) urls.push(part.url);
        if (part.image_url?.url) urls.push(part.image_url.url);
        const gen = part.metadata?.generation;
        if (gen?.image_url) urls.push(gen.image_url);
        if (gen?.url) urls.push(gen.url);
        const dalle = part.metadata?.dalle;
        if (dalle?.image_url) urls.push(dalle.image_url);
        if (dalle?.url) urls.push(dalle.url);
    }
    for (const fid of fileIds) {
        if (excludeFileIds.has(fid)) continue;
        const img = document.querySelector(`img[src*="${fid}"]`);
        if (img && img.src) urls.push(img.src);
    }
    return [...new Set(urls)];
}

function extractFileIdsFromParts(parts) {
    const ids = [];
    for (const part of parts) {
        if (!part || typeof part !== 'object') continue;
        if (part.asset_pointer && typeof part.asset_pointer === 'string') ids.push(part.asset_pointer.replace('file-service://', ''));
    }
    return ids;
}

function isImageInUserMessage(img) {
    const msgEl = img.closest('[data-message-author-role]');
    if (msgEl && msgEl.getAttribute('data-message-author-role') === 'user') return true;
    const msgContainer = img.closest('[data-message-id]');
    if (msgContainer) { if (msgContainer.querySelector('[data-message-author-role="user"]')) return true; }
    return false;
}

function getAllDomImages(excludeFileIds = _userUploadedFileIds) {
    const mainArea = document.querySelector('#thread') || document.querySelector('main') || document.body;
    const allImgs = [...mainArea.querySelectorAll('img[src^="https"]')];
    const results = allImgs.filter(img => {
        const s = img.src;
        if (s.includes('cdn.openai.com') || s.includes('favicon') || s.includes('sprites') || s.includes('avatar') || s.includes('og.png')) return false;
        if (isImageInUserMessage(img)) return false;
        for (const fid of excludeFileIds) { if (s.includes(fid)) return false; }
        if (s.includes('oaiusercontent') || s.includes('openai.com/file') || s.includes('dalleprodsec')) return true;
        if (img.naturalWidth >= 100 || img.width >= 100) return true;
        if (img.alt && img.alt.length > 5) return true;
        return false;
    }).map(img => img.src);
    return [...new Set(results)];
}

function getImagesFromDomByMsgId(msgId, excludeFileIds = _userUploadedFileIds) {
    if (!msgId) return [];
    let el = document.querySelector(`[data-message-id="${msgId}"]`);
    if (el) {
        const imgs = [...el.querySelectorAll('img[src^="https"]')].filter(img => {
            const s = img.src;
            if (s.includes('cdn.openai.com') || s.includes('favicon') || s.includes('sprites')) return false;
            if (isImageInUserMessage(img)) return false;
            for (const fid of excludeFileIds) { if (s.includes(fid)) return false; }
            return true;
        }).map(img => img.src);
        if (imgs.length) return imgs;
    }
    return [];
}

function extractPromptsFromCode(codeText) {
    const prompts = [];
    const r1 = /prompt\s*=\s*(?:"""([\s\S]*?)"""|'''([\s\S]*?)''')/g;
    let m;
    while ((m = r1.exec(codeText)) !== null) { const p = (m[1]||m[2]||'').trim(); if (p.length > 20) prompts.push(p); }
    if (!prompts.length) {
        const r2 = /prompt\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;
        while ((m = r2.exec(codeText)) !== null) { const p = (m[1]||m[2]||'').trim(); if (p.length > 20) prompts.push(p); }
    }
    if (!prompts.length) {
        const r3 = /text2im\s*\(\s*(?:"""([\s\S]*?)"""|'''([\s\S]*?)'''|"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;
        while ((m = r3.exec(codeText)) !== null) { const p = (m[1]||m[2]||m[3]||m[4]||'').trim(); if (p.length > 20) prompts.push(p); }
    }
    return prompts;
}

function buildRounds(conversationData) {
    const mapping = conversationData?.mapping;
    if (!mapping) return { rounds: [], userUploadedFileIds: new Set() };
    const path = getOrderedPath(mapping);
    const rounds = [];
    let currentRound = null;
    let lastAssistantMsgId = null;
    const userUploadedFileIds = new Set();

    function addPrompt(prompt, source, imageUrls, toolMsgId, fileIds) {
        if (!currentRound) { currentRound = { roundIndex: rounds.length + 1, userText: '...', prompts: [] }; rounds.push(currentRound); }
        const cleaned = prompt.replace(/<\|[a-z_]+\|>/gi, '').replace(/\s+$/, '');
        if (cleaned.length < 10 || seenPrompts.has(cleaned)) return;
        seenPrompts.add(cleaned);
        currentRound.prompts.push({
            id: String(Math.random()).slice(2), prompt: cleaned, source, imageUrls,
            fileIds: fileIds || [], selected: false, toolMsgId, lastAssistantMsgId,
        });
    }

    for (const nodeId of path) {
        const node = mapping[nodeId];
        const msg = node?.message;
        if (!msg) continue;
        const role = msg.author?.role;
        const ct = msg.content?.content_type;
        const parts = msg.content?.parts;
        const msgId = msg.id;

        if (role === 'user') {
            const firstPart = parts?.[0];
            if (ct === 'user_editable_context') continue;
            currentRound = { roundIndex: rounds.length + 1, userText: '', prompts: [] };
            const up = typeof firstPart === 'string' ? firstPart.substring(0, 40) : '';
            currentRound.userText = up;
            rounds.push(currentRound);
            lastAssistantMsgId = null;
            if (Array.isArray(parts)) {
                for (const part of parts) {
                    if (part && typeof part === 'object' && part.asset_pointer && typeof part.asset_pointer === 'string') {
                        const fid = part.asset_pointer.replace('file-service://', '');
                        if (fid) userUploadedFileIds.add(fid);
                    }
                }
            }
        }
        if (role === 'system') continue;
        if (role === 'assistant') lastAssistantMsgId = msgId;

        if (role === 'assistant' && ct === 'code' && Array.isArray(parts)) {
            for (const part of parts) {
                if (typeof part !== 'string') continue;
                for (const cp of extractPromptsFromCode(part)) addPrompt(cp, 'code', [], msgId);
            }
        }
        if (role === 'tool' && ct === 'multimodal_text' && Array.isArray(parts)) {
            const imgUrls = extractImageUrlsFromParts(parts);
            const fids = extractFileIdsFromParts(parts);
            for (const part of parts) {
                if (typeof part === 'string' && part.startsWith('Model caption:')) {
                    const cap = part.substring('Model caption:'.length).trim();
                    if (cap.length > 20) addPrompt(cap, 'caption', imgUrls, msgId, fids);
                }
                if (part && typeof part === 'object' && part.metadata) {
                    const gen = part.metadata.generation;
                    if (typeof gen === 'string' && gen.length > 20) addPrompt(gen, 'generation', imgUrls, msgId, fids);
                    else if (gen?.prompt?.length > 20) addPrompt(gen.prompt, 'gen.prompt', imgUrls, msgId, fids);
                    const pd = part.metadata.dalle;
                    if (pd) {
                        const rp = pd.revised_prompt || (pd.prompt?.length > 10 ? pd.prompt : null);
                        if (rp) addPrompt(rp, 'dalle', imgUrls, msgId, fids);
                    }
                }
            }
        }
        const dalle = msg.metadata?.dalle;
        if (dalle) { const rp = dalle.revised_prompt || (dalle.prompt?.length > 10 ? dalle.prompt : null); if (rp) addPrompt(rp, 'meta.dalle', [], msgId); }
        const igMeta = msg.metadata?.image_generation || msg.metadata?.image_gen_metadata;
        if (igMeta?.revised_prompt) addPrompt(igMeta.revised_prompt, 'ig_meta', [], msgId);
        const aggP = msg.metadata?.aggregate_result?.dalle?.prompts;
        if (Array.isArray(aggP)) for (const dp of aggP) { if (dp?.revised_prompt) addPrompt(dp.revised_prompt, 'agg', [], msgId); }
    }
    const filtered = rounds.filter(r => r.prompts.length > 0);
    filtered.forEach((r, i) => r.roundIndex = i + 1);
    return { rounds: filtered, userUploadedFileIds };
}

function enrichWithDomImages(rounds, conversationData, excludeFileIds = _userUploadedFileIds) {
    const domImgs = getAllDomImages(excludeFileIds);
    const allP = rounds.flatMap(r => r.prompts);
    if (conversationData?.mapping) {
        for (const item of allP.filter(p => p.imageUrls.length === 0)) {
            if (!item.toolMsgId) continue;
            for (const [, node] of Object.entries(conversationData.mapping)) {
                if (node?.message?.id === item.toolMsgId) {
                    const parts = node.message.content?.parts;
                    if (!Array.isArray(parts)) break;
                    const fileIds = extractFileIdsFromParts(parts);
                    for (const fid of fileIds) {
                        if (excludeFileIds.has(fid)) continue;
                        const domMatch = domImgs.find(url => url.includes(fid));
                        if (domMatch && !item.imageUrls.includes(domMatch)) item.imageUrls.push(domMatch);
                    }
                    break;
                }
            }
        }
    }
    for (const item of allP.filter(p => p.imageUrls.length === 0)) {
        const tryIds = [item.toolMsgId, item.lastAssistantMsgId].filter(Boolean);
        for (const mid of tryIds) { const urls = getImagesFromDomByMsgId(mid); if (urls.length) { item.imageUrls = urls; break; } }
    }
    if (domImgs.length > 0) {
        const usedUrls = new Set(allP.flatMap(p => p.imageUrls));
        const unusedDomImgs = domImgs.filter(u => !usedUrls.has(u));
        let idx = 0;
        for (const item of allP.filter(p => p.imageUrls.length === 0)) { if (idx < unusedDomImgs.length) item.imageUrls = [unusedDomImgs[idx++]]; }
    }
}

function resolveFileIds(excludeFileIds = _userUploadedFileIds) {
    const allP = allRounds.flatMap(r => r.prompts);
    for (const item of allP) {
        if (item.imageUrls.length > 0 || !item.fileIds || item.fileIds.length === 0) continue;
        for (const fid of item.fileIds) {
            if (excludeFileIds.has(fid)) continue;
            const img = document.querySelector(`img[src*="${fid}"]`);
            if (img && img.src && !item.imageUrls.includes(img.src)) item.imageUrls.push(img.src);
        }
    }
    if (allP.some(p => p.imageUrls.length === 0 && p.fileIds?.length > 0)) {
        const domImgs = getAllDomImages(excludeFileIds);
        const usedUrls = new Set(allP.flatMap(p => p.imageUrls));
        const unused = domImgs.filter(u => !usedUrls.has(u));
        let idx = 0;
        for (const item of allP) { if (item.imageUrls.length === 0 && idx < unused.length) item.imageUrls = [unused[idx++]]; }
    }
}

async function fetchAndExtractPrompts(forceRefresh) {
    const convId = getConversationId();
    if (!convId) return;
    const now = Date.now();
    if (!forceRefresh && now - lastFetchTime < FETCH_COOLDOWN) return;
    if (!forceRefresh && convId === lastFetchConvId && allRounds.length > 0) return;

    let token = getAccessToken();
    if (!token) { token = await refreshAccessToken(); if (!token) { toast('无法获取 token，请刷新页面'); return; } }

    lastFetchTime = now;
    log('请求对话数据:', convId);
    try {
        const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        let resp = await win.fetch(`https://chatgpt.com/backend-api/conversation/${convId}`, {
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            credentials: 'include',
        });
        if (resp.status === 401 || resp.status === 403) {
            token = await refreshAccessToken();
            if (token) resp = await win.fetch(`https://chatgpt.com/backend-api/conversation/${convId}`, {
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, credentials: 'include',
            });
        }
        if (resp.status === 429) { toast('请求太频繁，请稍后手动重试'); return; }
        if (!resp.ok) { log('API 返回:', resp.status); return; }

        const data = await resp.json();
        lastFetchConvId = convId;
        seenPrompts.clear();
        const result = buildRounds(data);
        allRounds = result.rounds;
        _userUploadedFileIds = result.userUploadedFileIds;
        enrichWithDomImages(allRounds, data, _userUploadedFileIds);

        const total = allRounds.reduce((s, r) => s + r.prompts.length, 0);
        log(`提取 ${total} 个提示词，${allRounds.length} 轮对话`);
        renderExtractedTab();

        const noImgCount = allRounds.flatMap(r => r.prompts).filter(p => p.imageUrls.length === 0).length;
        if (noImgCount > 0) {
            setTimeout(() => { enrichWithDomImages(allRounds, data, _userUploadedFileIds); renderExtractedTab(); }, 3000);
        }
    } catch(e) { log('请求失败:', e.message); }
}

async function manualFetchPrompts() {
    if (!getConversationId()) { toast('请先打开一个对话'); return; }
    if (isFetchingPrompts) return;
    const refreshBtn = document.getElementById('gpt-refresh');
    isFetchingPrompts = true;
    if (refreshBtn) { refreshBtn.disabled = true; refreshBtn.innerHTML = `${SVG.refresh} 提取中`; }
    try { await fetchAndExtractPrompts(true); }
    finally { isFetchingPrompts = false; if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.innerHTML = `${SVG.refresh} 提取`; } }
}

// ============================================================
// Section 7: Image Download & ZIP
// ============================================================
function getJSZip() {
    if (typeof JSZip !== 'undefined') return JSZip;
    if (window.JSZip) return window.JSZip;
    return null;
}

async function downloadImage(url, filename) {
    try {
        const r = await fetch(url, { credentials: 'include' });
        const blob = await r.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = filename; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    } catch(e) { window.open(url, '_blank'); }
}

async function downloadAsZip(urls, zipName) {
    if (!urls.length) { toast('没有可下载的图片'); return; }
    try {
        toast(`正在打包 ${urls.length} 张图片...`);
        const ZipClass = getJSZip();
        if (!ZipClass) throw new Error('JSZip 未加载');
        const zip = new ZipClass();
        let done = 0;
        for (let i = 0; i < urls.length; i++) {
            try {
                const r = await fetch(urls[i], { credentials: 'include' });
                const blob = await r.blob();
                const ext = blob.type?.includes('png') ? 'png' : blob.type?.includes('webp') ? 'webp' : 'jpg';
                zip.file(`image-${i+1}.${ext}`, blob); done++;
            } catch(e) { log('图片下载失败:', urls[i]); }
        }
        if (done === 0) { toast('所有图片下载失败'); return; }
        const content = await zip.generateAsync({ type: 'blob' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(content); a.download = zipName; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 3000);
        toast(`已打包 ${done} 张图片`);
    } catch(e) { log('ZIP 打包失败:', e.message); toast('打包失败'); }
}

// ============================================================
// Section 8: SVG Icons
// ============================================================
const SVG = {
    brush: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08"/><path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z"/></svg>`,
    book: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/></svg>`,
    arrow: `<svg class="gpt-arrow" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`,
    copy: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
    check: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    refresh: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14"/></svg>`,
    download: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
    img: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity=".3"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,
    save: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>`,
    fill: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>`,
};

// ============================================================
// Section 9: UI - Styles
// ============================================================
function injectStyles() {
    if (document.getElementById('gpt-styles')) return;
    const s = document.createElement('style');
    s.id = 'gpt-styles';
    s.textContent = `
/* ---- Shared ---- */
#gpt-fab{position:fixed;bottom:80px;right:20px;z-index:99999;width:48px;height:48px;border-radius:50%;
    border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;
    background:linear-gradient(135deg,#10a37f,#1a7f64);color:#fff;
    box-shadow:0 4px 16px rgba(16,163,127,.35);transition:all .25s;user-select:none}
#gpt-fab:hover{transform:scale(1.08)}
#gpt-fab .gpt-badge{position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;
    border-radius:9px;background:#ef4444;color:#fff;font-size:10px;font-weight:700;
    display:flex;align-items:center;justify-content:center;padding:0 4px}
#gpt-panel{flex:0 0 auto;width:0;height:100%;overflow:hidden;
    background:#fff;display:flex;flex-direction:column;
    border-left:1px solid rgba(13,13,13,.05);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    font-size:14px;transition:width .25s ease}
#gpt-panel.gpt-open{width:420px}
html.dark #gpt-panel{background:#1e1e2e;border-left-color:rgba(255,255,255,.06)}
.gpt-tabs{display:flex;border-bottom:1px solid rgba(0,0,0,.08);flex-shrink:0}
html.dark .gpt-tabs{border-bottom-color:rgba(255,255,255,.08)}
.gpt-tab{flex:1;padding:12px 8px;text-align:center;font-size:13px;font-weight:600;
    cursor:pointer;color:#9ca3af;border-bottom:2px solid transparent;transition:all .15s;
    display:flex;align-items:center;justify-content:center;gap:6px}
.gpt-tab:hover{color:#6b7280}
.gpt-tab.gpt-active{color:#10a37f;border-bottom-color:#10a37f}
html.dark .gpt-tab{color:#6b7280}
html.dark .gpt-tab:hover{color:#9ca3af}
html.dark .gpt-tab.gpt-active{color:#10a37f}
.gpt-tab-body{flex:1;overflow:hidden;display:none;flex-direction:column}
.gpt-tab-body.gpt-active{display:flex}
.gpt-toast{position:fixed;bottom:80px;left:50%;transform:translateX(-50%) translateY(16px);
    background:#10a37f;color:#fff;padding:7px 18px;border-radius:8px;font-size:13px;
    z-index:100002;opacity:0;transition:all .28s;pointer-events:none}
.gpt-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}

/* ---- Extracted Tab (rp- prefix) ---- */
.rp-hdr{display:flex;align-items:center;gap:8px;padding:12px 14px;flex-shrink:0;
    border-bottom:1px solid rgba(0,0,0,.06);font-weight:600;font-size:13px;color:#202123}
html.dark .rp-hdr{border-bottom-color:rgba(255,255,255,.06);color:#e5e5e5}
.rp-hdr-right{margin-left:auto;display:flex;align-items:center;gap:6px}
.rp-sel-all{font-size:11px;padding:3px 8px;border:1px solid rgba(16,163,127,.3);border-radius:5px;
    background:none;color:#10a37f;cursor:pointer;font-family:inherit}
.rp-sel-all:hover{background:rgba(16,163,127,.07)}
.rp-refresh{font-size:11px;padding:3px 8px;border:1px solid rgba(16,163,127,.3);border-radius:5px;
    background:#10a37f;color:#fff;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:4px}
.rp-refresh:hover{background:#0d8a6b}
.rp-refresh:disabled{background:#9ca3af;border-color:#9ca3af;cursor:not-allowed}
.rp-count-badge{font-size:11px;font-weight:500;color:#6e6e80;background:rgba(0,0,0,.05);
    padding:2px 8px;border-radius:10px}
html.dark .rp-count-badge{background:rgba(255,255,255,.08);color:#9ca3af}
.rp-body{overflow-y:auto;flex:1;padding:6px}
.rp-round-divider{display:flex;align-items:center;gap:8px;margin:10px 4px 6px;font-size:11px;
    font-weight:600;color:#9ca3af}
.rp-round-divider::before,.rp-round-divider::after{content:'';flex:1;height:1px;background:rgba(0,0,0,.08)}
html.dark .rp-round-divider::before,html.dark .rp-round-divider::after{background:rgba(255,255,255,.08)}
.rp-round-dl{font-size:10px;padding:2px 7px;border:1px solid rgba(16,163,127,.3);border-radius:4px;
    background:none;color:#10a37f;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0;
    display:inline-flex;align-items:center;gap:3px}
.rp-round-dl:hover{background:rgba(16,163,127,.08)}
.rp-card{border-radius:10px;margin-bottom:5px;overflow:hidden;border:1px solid rgba(0,0,0,.07);transition:border-color .18s}
.rp-card:hover{border-color:rgba(16,163,127,.25)}
html.dark .rp-card{border-color:rgba(255,255,255,.07)}
html.dark .rp-card:hover{border-color:rgba(16,163,127,.3)}
.rp-card.selected{border-color:#10a37f;background:rgba(16,163,127,.04)}
html.dark .rp-card.selected{background:rgba(16,163,127,.08)}
.rp-card-hdr{display:flex;align-items:center;gap:7px;padding:8px 10px;cursor:pointer;
    user-select:none;font-size:11px;font-weight:500;color:#6e6e80;transition:background .13s}
.rp-card-hdr:hover{background:rgba(0,0,0,.02)}
html.dark .rp-card-hdr{color:#9ca3af}
html.dark .rp-card-hdr:hover{background:rgba(255,255,255,.03)}
.rp-cb{appearance:none;-webkit-appearance:none;width:16px;height:16px;
    border:1px solid rgba(0,0,0,.2);border-radius:4px;background:#fff;
    cursor:pointer;flex-shrink:0;margin:0;position:relative;transition:all .15s}
html.dark .rp-cb{background:transparent;border-color:rgba(255,255,255,.3)}
.rp-cb:checked{background:#10a37f;border-color:#10a37f}
.rp-cb:checked::after{content:'';position:absolute;left:4.5px;top:1.5px;width:4px;height:8px;
    border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}
.rp-thumb-strip{display:flex;gap:3px;flex-shrink:0;position:relative}
.rp-thumb{width:48px;height:48px;object-fit:cover;border-radius:6px;
    border:1px solid rgba(0,0,0,.08);background:#f3f4f6;cursor:pointer}
html.dark .rp-thumb{border-color:rgba(255,255,255,.1);background:#374151}
.rp-thumb-ph{width:48px;height:48px;border-radius:6px;border:1px dashed rgba(0,0,0,.12);
    background:rgba(0,0,0,.03);display:flex;align-items:center;justify-content:center;flex-shrink:0}
html.dark .rp-thumb-ph{border-color:rgba(255,255,255,.1);background:rgba(255,255,255,.03)}
.rp-hover-preview{position:fixed;z-index:100001;pointer-events:none;
    max-width:320px;max-height:420px;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.35);
    opacity:0;transition:opacity .18s}
.rp-hover-preview.show{opacity:1}
.rp-card-meta{display:flex;flex-direction:column;gap:3px;flex:1;min-width:0}
.rp-tag{padding:1px 5px;border-radius:4px;font-size:10px;font-weight:600;align-self:flex-start;
    background:rgba(0,0,0,.06);color:#9ca3af;line-height:1.4;font-family:'SF Mono',Menlo,monospace}
html.dark .rp-tag{background:rgba(255,255,255,.08);color:#6b7280}
.rp-preview{font-size:11px;color:#aaa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
html.dark .rp-preview{color:#555}
.rp-arrow{flex-shrink:0;transition:transform .18s;color:#10a37f;opacity:.7}
.rp-card.open .rp-arrow{transform:rotate(90deg)}
.rp-card-body{display:none;padding:0 10px 10px}
.rp-card.open .rp-card-body{display:block}
.rp-txt{background:rgba(0,0,0,.03);border-radius:7px;padding:9px 11px;
    font-family:'SF Mono',Menlo,Consolas,monospace;font-size:11px;line-height:1.6;
    white-space:pre-wrap;word-break:break-word;max-height:160px;overflow-y:auto;color:#374151}
html.dark .rp-txt{background:rgba(255,255,255,.04);color:#d1d5db}
.rp-card-acts{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
.rp-copy-btn,.rp-dl-btn,.rp-save-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;
    padding:7px 12px;border:none;border-radius:7px;font-size:12px;font-weight:500;
    cursor:pointer;font-family:inherit;transition:all .15s;flex:1}
.rp-copy-btn{background:rgba(16,163,127,.1);color:#10a37f}
.rp-copy-btn:hover{background:rgba(16,163,127,.2)}
.rp-copy-btn.ok{background:#10a37f;color:#fff}
.rp-dl-btn{background:rgba(59,130,246,.08);color:#3b82f6}
.rp-dl-btn:hover{background:rgba(59,130,246,.15)}
.rp-save-btn{background:rgba(245,166,35,.1);color:#f5a623}
.rp-save-btn:hover{background:rgba(245,166,35,.2)}
.rp-save-btn.saved{background:#f5a623;color:#fff}
.rp-footer{padding:8px 10px;border-top:1px solid rgba(0,0,0,.06);display:flex;gap:6px;flex-shrink:0}
html.dark .rp-footer{border-top-color:rgba(255,255,255,.06)}
.rp-dl-sel-btn,.rp-dl-all-btn{display:inline-flex;align-items:center;justify-content:center;
    gap:5px;padding:7px 10px;border:none;border-radius:8px;font-size:12px;font-weight:500;
    cursor:pointer;font-family:inherit;transition:all .15s}
.rp-dl-sel-btn{background:#10a37f;color:#fff;flex:1}
.rp-dl-sel-btn:hover{background:#0d8a6b}
.rp-dl-sel-btn:disabled{background:#9ca3af;cursor:not-allowed}
.rp-dl-all-btn{background:rgba(16,163,127,.1);color:#10a37f;flex:1}
.rp-dl-all-btn:hover{background:rgba(16,163,127,.2)}
.rp-empty{text-align:center;color:#9ca3af;padding:40px 20px;font-size:13px}

/* ---- Library Tab (pm- prefix) ---- */
.pm-search-bar{padding:10px 14px;border-bottom:1px solid rgba(0,0,0,.06);flex-shrink:0}
html.dark .pm-search-bar{border-bottom-color:rgba(255,255,255,.06)}
.pm-search-bar input{width:100%;box-sizing:border-box;background:rgba(0,0,0,.03);border:1px solid rgba(0,0,0,.1);
    color:#374151;padding:8px 12px;border-radius:8px;font-size:13px;outline:none}
html.dark .pm-search-bar input{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.1);color:#e0e0e0}
.pm-search-bar input:focus{border-color:#10a37f}
.pm-search-bar input::placeholder{color:#9ca3af}
.pm-categories{display:flex;gap:6px;padding:8px 14px;overflow-x:auto;
    border-bottom:1px solid rgba(0,0,0,.06);flex-shrink:0;flex-wrap:wrap}
html.dark .pm-categories{border-bottom-color:rgba(255,255,255,.06)}
.pm-cat-btn{background:rgba(0,0,0,.04);border:1px solid rgba(0,0,0,.1);color:#6b7280;
    padding:4px 10px;border-radius:12px;cursor:pointer;font-size:12px;white-space:nowrap;
    display:inline-flex;align-items:center;gap:4px;position:relative}
html.dark .pm-cat-btn{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.1);color:#9ca3af}
.pm-cat-btn.pm-active{background:#10a37f;border-color:#10a37f;color:#fff}
.pm-cat-del{background:none;border:none;color:inherit;cursor:pointer;font-size:14px;
    padding:0 0 0 2px;line-height:1;opacity:.5;transition:opacity .15s}
.pm-cat-del:hover{opacity:1;color:#ef4444}
.pm-cat-btn.pm-active .pm-cat-del:hover{color:#fff}
.pm-cat-add{background:none;border:1px dashed rgba(0,0,0,.15);color:#9ca3af;
    padding:4px 10px;border-radius:12px;cursor:pointer;font-size:12px;white-space:nowrap}
html.dark .pm-cat-add{border-color:rgba(255,255,255,.15);color:#6b7280}
.pm-cat-add:hover{border-color:#10a37f;color:#10a37f}
.pm-list{flex:1;overflow-y:auto;padding:8px 10px}
.pm-item{background:rgba(0,0,0,.02);border:1px solid rgba(0,0,0,.07);border-radius:10px;
    padding:12px;margin-bottom:8px;cursor:pointer;transition:border-color .15s}
.pm-item:hover{border-color:rgba(16,163,127,.25)}
html.dark .pm-item{background:rgba(255,255,255,.03);border-color:rgba(255,255,255,.07)}
html.dark .pm-item:hover{border-color:rgba(16,163,127,.3)}
.pm-item-title{font-weight:600;color:#202123;margin-bottom:4px;display:flex;align-items:center;gap:6px}
html.dark .pm-item-title{color:#e5e5e5}
.pm-item-title .pm-fav{color:#f5a623;font-size:12px}
.pm-item-preview{color:#9ca3af;font-size:12px;line-height:1.4;max-height:40px;overflow:hidden;
    text-overflow:ellipsis;margin-bottom:6px}
.pm-item-meta{display:flex;align-items:center;justify-content:space-between}
.pm-item-tags{display:flex;gap:4px;flex-wrap:wrap}
.pm-tag{background:rgba(0,0,0,.05);color:#6b7280;padding:2px 6px;border-radius:4px;font-size:11px}
html.dark .pm-tag{background:rgba(255,255,255,.08);color:#9ca3af}
.pm-var-tag{background:rgba(59,130,246,.1);color:#3b82f6}
html.dark .pm-var-tag{background:rgba(59,130,246,.15);color:#60a5fa}
.pm-item-actions{display:flex;gap:4px}
.pm-item-actions button{background:transparent;border:1px solid rgba(0,0,0,.12);color:#6b7280;
    padding:3px 8px;border-radius:4px;cursor:pointer;font-size:11px;display:inline-flex;align-items:center;gap:3px}
html.dark .pm-item-actions button{border-color:rgba(255,255,255,.12);color:#9ca3af}
.pm-item-actions button:hover{background:rgba(0,0,0,.05);color:#374151}
html.dark .pm-item-actions button:hover{background:rgba(255,255,255,.08);color:#e5e5e5}
.pm-btn-fill-send{background:rgba(16,163,127,.1) !important;color:#10a37f !important;
    border-color:rgba(16,163,127,.2) !important}
.pm-btn-fill-send:hover{background:rgba(16,163,127,.2) !important;color:#0e8c6d !important}
.pm-item-actions .pm-btn-del:hover{border-color:#ef4444;color:#ef4444}
.pm-add-bar{padding:10px 14px;border-top:1px solid rgba(0,0,0,.06);flex-shrink:0;
    display:flex;gap:6px}
html.dark .pm-add-bar{border-top-color:rgba(255,255,255,.06)}
.pm-add-btn{flex:1;background:#10a37f;border:none;color:#fff;padding:10px;border-radius:8px;
    cursor:pointer;font-size:14px;font-weight:600}
.pm-add-btn:hover{background:#0e8c6d}
.pm-export-btn{background:rgba(0,0,0,.05);border:1px solid rgba(0,0,0,.1);color:#6b7280;
    padding:10px 14px;border-radius:8px;cursor:pointer;font-size:12px}
html.dark .pm-export-btn{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.1);color:#9ca3af}
.pm-empty{text-align:center;color:#9ca3af;padding:40px 20px;font-size:13px}

/* ---- Modal ---- */
.pm-modal-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.6);
    z-index:100000;display:flex;align-items:center;justify-content:center}
.pm-modal{background:#fff;border-radius:12px;width:360px;max-height:80vh;overflow-y:auto;padding:20px}
html.dark .pm-modal{background:#2a2a2a;border:1px solid rgba(255,255,255,.1)}
.pm-modal h4{margin:0 0 16px;color:#202123;font-size:15px}
html.dark .pm-modal h4{color:#e5e5e5}
.pm-modal label{display:block;margin-bottom:4px;color:#6b7280;font-size:12px}
.pm-modal input,.pm-modal textarea,.pm-modal select{width:100%;box-sizing:border-box;
    background:rgba(0,0,0,.03);border:1px solid rgba(0,0,0,.1);color:#374151;
    padding:8px 10px;border-radius:6px;font-size:13px;margin-bottom:12px;outline:none;font-family:inherit}
html.dark .pm-modal input,html.dark .pm-modal textarea,html.dark .pm-modal select{
    background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.1);color:#e0e0e0}
.pm-modal input:focus,.pm-modal textarea:focus,.pm-modal select:focus{border-color:#10a37f}
.pm-modal textarea{min-height:100px;resize:vertical}
.pm-modal-btns{display:flex;gap:8px;justify-content:flex-end;margin-top:4px}
.pm-modal-btns button{padding:8px 18px;border-radius:6px;cursor:pointer;font-size:13px;border:none}
.pm-btn-cancel{background:rgba(0,0,0,.06);color:#6b7280}
html.dark .pm-btn-cancel{background:rgba(255,255,255,.08);color:#9ca3af}
.pm-btn-save{background:#10a37f;color:#fff}
.pm-btn-cancel:hover{background:rgba(0,0,0,.1)}
html.dark .pm-btn-cancel:hover{background:rgba(255,255,255,.12)}
.pm-btn-save:hover{background:#0e8c6d}

/* ---- Close button ---- */
.gpt-close{background:none;border:none;color:#9ca3af;cursor:pointer;padding:4px;margin-left:auto;
    display:flex;align-items:center;justify-content:center}
.gpt-close:hover{color:#374151}
html.dark .gpt-close:hover{color:#e5e5e5}
    `;
    document.head.appendChild(s);
}

// ============================================================
// Section 10: UI - Toast
// ============================================================
function toast(m) {
    let t = document.querySelector('.gpt-toast');
    if (!t) { t = document.createElement('div'); t.className = 'gpt-toast'; document.body.appendChild(t); }
    t.textContent = m; t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), 2000);
}

// ============================================================
// Section 11: UI - FAB
// ============================================================
function createFab() {
    if (document.getElementById(Config.FAB_ID)) return;
    const fab = document.createElement('button');
    fab.id = Config.FAB_ID;
    fab.title = '提示词套件';
    fab.innerHTML = SVG.brush;
    fab.style.display = 'flex';
    fab.onclick = () => togglePanel();
    document.body.appendChild(fab);
}

function updateFab() {
    const fab = document.getElementById(Config.FAB_ID);
    if (!fab) return;
    const extracted = allRounds.reduce((s, r) => s + r.prompts.length, 0);
    const old = fab.querySelector('.gpt-badge'); if (old) old.remove();
    if (extracted > 0) {
        const b = document.createElement('span'); b.className = 'gpt-badge'; b.textContent = extracted;
        fab.appendChild(b);
    }
}

let panelVisible = false;
let activeTab = 'extracted';

function togglePanel(force) {
    const panel = document.getElementById(Config.PANEL_ID);
    if (!panel) return;
    panelVisible = force !== undefined ? force : !panelVisible;
    panel.classList.toggle('gpt-open', panelVisible);
    if (panelVisible) {
        if (activeTab === 'extracted') renderExtractedTab();
        else LibraryUI.render();
    }
}

function switchTab(tabName) {
    activeTab = tabName;
    document.querySelectorAll('.gpt-tab').forEach(t => t.classList.toggle('gpt-active', t.dataset.tab === tabName));
    document.querySelectorAll('.gpt-tab-body').forEach(b => b.classList.toggle('gpt-active', b.dataset.tab === tabName));
    if (tabName === 'extracted') renderExtractedTab();
    else LibraryUI.render();
}

// ============================================================
// Section 12: UI - Panel Shell
// ============================================================
function createPanel() {
    if (document.getElementById(Config.PANEL_ID)) return;
    const panel = document.createElement('div');
    panel.id = Config.PANEL_ID;
    panel.innerHTML = `
        <div class="gpt-tabs">
            <div class="gpt-tab gpt-active" data-tab="extracted">${SVG.brush.replace('width="20" height="20"','width="14" height="14"')} 优化提示词</div>
            <div class="gpt-tab" data-tab="library">${SVG.book} 提示词库</div>
            <button class="gpt-close" id="gpt-close" title="关闭">${SVG.arrow.replace('class="gpt-arrow"','style="transform:rotate(180deg)"')}</button>
        </div>
        <div class="gpt-tab-body gpt-active" data-tab="extracted">
            <div class="rp-hdr">
                <span>提取结果</span>
                <div class="rp-hdr-right">
                    <button class="rp-refresh" id="gpt-refresh">${SVG.refresh} 提取</button>
                    <button class="rp-sel-all" id="rp-sel-all">全选</button>
                    <span class="rp-count-badge" id="rp-count">0</span>
                </div>
            </div>
            <div class="rp-body" id="rp-body"></div>
            <div class="rp-footer">
                <button class="rp-dl-sel-btn" id="rp-dl-sel" disabled>${SVG.download} 下载选中 (0)</button>
                <button class="rp-dl-all-btn" id="rp-dl-all">${SVG.download} 全部下载</button>
            </div>
        </div>
        <div class="gpt-tab-body" data-tab="library">
            <div class="pm-search-bar">
                <input id="pm-search" type="text" placeholder="搜索提示词..." />
            </div>
            <div class="pm-categories" id="pm-categories"></div>
            <div class="pm-list" id="pm-list"></div>
            <div class="pm-add-bar">
                <button class="pm-add-btn" id="pm-btn-add">+ 新增提示词</button>
                <button class="pm-export-btn" id="pm-btn-export" title="导出 JSON">导出</button>
            </div>
            <input type="file" id="pm-file-input" accept=".json" style="display:none" />
        </div>`;
    // Mount as flex sibling of main content (same row as left sidebar)
    const sidebar = document.getElementById('stage-slideover-sidebar');
    const contentRow = sidebar?.parentElement;
    if (contentRow) {
        contentRow.appendChild(panel);
    } else {
        document.body.appendChild(panel); // fallback
    }

    // Tab switching
    panel.querySelectorAll('.gpt-tab').forEach(tab => {
        tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });

    // Close
    document.getElementById('gpt-close').addEventListener('click', () => togglePanel(false));

    // Extracted tab events
    document.getElementById('gpt-refresh').addEventListener('click', manualFetchPrompts);
    document.getElementById('rp-sel-all').addEventListener('click', toggleSelectAll);
    document.getElementById('rp-dl-sel').addEventListener('click', downloadSelected);
    document.getElementById('rp-dl-all').addEventListener('click', downloadAll);

    // Library tab events
    document.getElementById('pm-btn-add').addEventListener('click', () => LibraryUI.showEditModal());
    document.getElementById('pm-btn-export').addEventListener('click', () => {
        StorageService.exportJSON(LibraryUI._prompts);
        toast('已导出提示词数据');
    });
    document.getElementById('pm-search').addEventListener('input', e => {
        LibraryUI._searchKeyword = e.target.value;
        LibraryUI.renderList();
    });
    document.getElementById('pm-file-input').addEventListener('change', e => LibraryUI._handleImport(e));
}

// ============================================================
// Section 13: UI - Extracted Tab
// ============================================================
function toggleSelectAll() {
    const allP = allRounds.flatMap(r => r.prompts);
    const allSelected = allP.every(p => p.selected);
    allP.forEach(p => p.selected = !allSelected);
    document.querySelectorAll('.rp-cb').forEach(cb => cb.checked = !allSelected);
    document.querySelectorAll('.rp-card').forEach(card => card.classList.toggle('selected', !allSelected));
    document.getElementById('rp-sel-all').textContent = allSelected ? '全选' : '取消全选';
    updateExtractedFooter();
}

function updateExtractedFooter() {
    const allP = allRounds.flatMap(r => r.prompts);
    const selCount = allP.filter(p => p.selected).length;
    const btn = document.getElementById('rp-dl-sel');
    if (btn) { btn.disabled = selCount === 0; btn.innerHTML = `${SVG.download} 下载选中 (${selCount})`; }
    const allBtn = document.getElementById('rp-dl-all');
    if (allBtn) allBtn.innerHTML = `${SVG.download} 全部下载 (${allP.length})`;
    const countEl = document.getElementById('rp-count');
    if (countEl) countEl.textContent = allP.length + ' 条';
}

async function downloadSelected() {
    const selP = allRounds.flatMap(r => r.prompts).filter(p => p.selected);
    const urls = selP.flatMap(p => p.imageUrls);
    if (!urls.length) return;
    await downloadAsZip(urls, `chatgpt-selected-${urls.length}imgs.zip`);
}

async function downloadAll() {
    const urls = allRounds.flatMap(r => r.prompts).flatMap(p => p.imageUrls);
    if (!urls.length) { toast('没有可下载的图片'); return; }
    await downloadAsZip(urls, `chatgpt-all-${urls.length}imgs.zip`);
}

function renderExtractedTab() {
    resolveFileIds();
    const body = document.getElementById('rp-body');
    if (!body) return;
    body.innerHTML = '';

    if (allRounds.length === 0) {
        body.innerHTML = '<div class="rp-empty">点击右上角「提取」按钮获取当前对话的优化提示词</div>';
        updateFab(); updateExtractedFooter();
        return;
    }

    let globalIdx = 0;
    for (const round of allRounds) {
        if (!round.prompts.length) continue;
        const div = document.createElement('div');
        div.className = 'rp-round-divider';
        div.innerHTML = `第 ${round.roundIndex} 轮`;
        const roundImgs = round.prompts.flatMap(p => p.imageUrls);
        if (roundImgs.length > 0) {
            const btn = document.createElement('button');
            btn.className = 'rp-round-dl';
            btn.innerHTML = `${SVG.download} 下载 (${roundImgs.length})`;
            btn.onclick = async (e) => { e.stopPropagation(); await downloadAsZip(roundImgs, `chatgpt-round${round.roundIndex}-${roundImgs.length}imgs.zip`); };
            div.appendChild(btn);
        }
        body.appendChild(div);
        for (const item of round.prompts) { globalIdx++; body.appendChild(buildExtractedCard(item, globalIdx)); }
    }
    updateFab(); updateExtractedFooter();
}

function buildExtractedCard(item, index) {
    const card = document.createElement('div');
    card.className = 'rp-card' + (item.selected ? ' selected' : '');
    card.dataset.id = item.id;
    const preview = item.prompt.substring(0, 55).replace(/\n/g, ' ') + (item.prompt.length > 55 ? '...' : '');

    let thumbsHtml = '';
    if (item.imageUrls.length > 0) {
        thumbsHtml = '<div class="rp-thumb-strip">';
        item.imageUrls.slice(0, 2).forEach(url => {
            thumbsHtml += `<img class="rp-thumb" src="${escHtml(url)}" loading="lazy" data-preview-url="${escHtml(url)}" onerror="this.style.display='none'">`;
        });
        thumbsHtml += '</div>';
    } else {
        thumbsHtml = `<div class="rp-thumb-ph">${SVG.img}</div>`;
    }

    card.innerHTML = `
        <div class="rp-card-hdr">
            <input type="checkbox" class="rp-cb" ${item.selected ? 'checked' : ''}>
            ${thumbsHtml}
            <div class="rp-card-meta">
                <span class="rp-tag">#${index || '?'}</span>
                <span class="rp-preview">${escHtml(preview)}</span>
            </div>
            ${SVG.arrow}
        </div>
        <div class="rp-card-body">
            <div class="rp-txt">${escHtml(item.prompt)}</div>
            <div class="rp-card-acts">
                <button class="rp-copy-btn">${SVG.copy} 复制</button>
                <button class="rp-save-btn" title="保存到提示词库">${SVG.save} 存到库</button>
                ${item.imageUrls.length > 0 ? `<button class="rp-dl-btn">${SVG.download} 下载图片</button>` : ''}
            </div>
        </div>`;

    const hdr = card.querySelector('.rp-card-hdr');
    const cb = card.querySelector('.rp-cb');
    cb.onclick = e => { e.stopPropagation(); item.selected = cb.checked; card.classList.toggle('selected', cb.checked); updateExtractedFooter(); };

    // Thumbnail hover preview
    card.querySelectorAll('.rp-thumb').forEach(thumb => {
        const previewUrl = thumb.dataset.previewUrl;
        let previewEl = null;
        thumb.addEventListener('mouseenter', e => {
            e.stopPropagation(); if (!previewUrl) return;
            if (!previewEl) { previewEl = document.createElement('img'); previewEl.className = 'rp-hover-preview'; previewEl.src = previewUrl; document.body.appendChild(previewEl); }
            const rect = thumb.getBoundingClientRect();
            previewEl.style.top = Math.max(8, rect.top - 96) + 'px';
            previewEl.style.left = Math.max(8, rect.left - 252) + 'px';
            requestAnimationFrame(() => previewEl.classList.add('show'));
        });
        thumb.addEventListener('mouseleave', () => { if (previewEl) previewEl.classList.remove('show'); });
        thumb.addEventListener('click', e => { e.stopPropagation(); if (previewUrl) window.open(previewUrl, '_blank'); });
    });

    hdr.onclick = e => { if (e.target === cb || e.target.classList?.contains('rp-thumb')) return; card.classList.toggle('open'); };

    // Copy
    const copyBtn = card.querySelector('.rp-copy-btn');
    copyBtn.onclick = e => {
        e.stopPropagation();
        navigator.clipboard.writeText(item.prompt).catch(() => {});
        copyBtn.classList.add('ok'); copyBtn.innerHTML = SVG.check + ' 已复制'; toast('已复制到剪贴板');
        setTimeout(() => { copyBtn.classList.remove('ok'); copyBtn.innerHTML = SVG.copy + ' 复制'; }, 1500);
    };

    // Save to Library
    const saveBtn = card.querySelector('.rp-save-btn');
    saveBtn.onclick = e => {
        e.stopPropagation();
        LibraryUI.showEditModal(null, {
            title: item.prompt.substring(0, 30).replace(/\n/g, ' '),
            content: item.prompt,
            category: '通用模板',
            tags: ['DALL-E', 'extracted'],
        });
        switchTab('library');
        saveBtn.classList.add('saved'); saveBtn.innerHTML = SVG.check + ' 已存';
        setTimeout(() => { saveBtn.classList.remove('saved'); saveBtn.innerHTML = SVG.save + ' 存到库'; }, 2000);
    };

    // Download image
    const dlBtn = card.querySelector('.rp-dl-btn');
    if (dlBtn) dlBtn.onclick = async e => {
        e.stopPropagation();
        toast(`下载 ${item.imageUrls.length} 张图片...`);
        for (let i = 0; i < item.imageUrls.length; i++) { await downloadImage(item.imageUrls[i], `chatgpt-img-${i+1}.png`); await new Promise(r => setTimeout(r, 300)); }
    };

    return card;
}

// ============================================================
// Section 14: UI - Library Tab
// ============================================================
const LibraryUI = {
    _prompts: [],
    _categories: [],
    _searchKeyword: '',
    _activeCategory: '全部',
    _editingId: null,

    async init() {
        this._prompts = await StorageService.load();
        this._categories = await StorageService.loadCategories();
    },

    _getCategoryList() {
        // Merge stored categories with any categories found in prompts
        const fromPrompts = new Set(this._prompts.map(p => p.category).filter(Boolean));
        const merged = [...new Set([...this._categories, ...fromPrompts])];
        return merged;
    },

    async _addCategory(name) {
        name = name.trim();
        if (!name) return;
        if (this._categories.includes(name)) { toast('该分类已存在'); return; }
        this._categories.push(name);
        await StorageService.saveCategories(this._categories);
        this.renderCategories();
    },

    async _deleteCategory(name) {
        const count = this._prompts.filter(p => p.category === name).length;
        if (count > 0) {
            if (!confirm(`分类「${name}」下有 ${count} 条提示词，删除后这些提示词的分类不会改变。确定删除？`)) return;
        }
        this._categories = this._categories.filter(c => c !== name);
        await StorageService.saveCategories(this._categories);
        if (this._activeCategory === name) this._activeCategory = '全部';
        this.renderCategories();
        this.renderList();
    },

    render() {
        this.renderCategories();
        this.renderList();
    },

    renderCategories() {
        const container = document.getElementById('pm-categories');
        if (!container) return;
        const cats = ['全部', ...this._getCategoryList()];
        const uniqueCats = [...new Set(cats)];

        let html = uniqueCats.map(c => {
            const isActive = c === this._activeCategory;
            const canDelete = c !== '全部';
            return `<span class="pm-cat-btn${isActive ? ' pm-active' : ''}" data-cat="${c}">${c}${canDelete ? '<button class="pm-cat-del" data-cat="' + c + '" title="删除分类">×</button>' : ''}</span>`;
        }).join('');
        html += '<button class="pm-cat-add" id="pm-cat-add" title="新增分类">+ </button>';

        container.innerHTML = html;

        container.querySelectorAll('[data-cat]').forEach(btn => {
            if (btn.classList.contains('pm-cat-del')) return;
            btn.addEventListener('click', e => {
                if (e.target.classList.contains('pm-cat-del')) return;
                this._activeCategory = btn.dataset.cat;
                this.renderCategories();
                this.renderList();
            });
        });

        container.querySelectorAll('.pm-cat-del').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                this._deleteCategory(btn.dataset.cat);
            });
        });

        document.getElementById('pm-cat-add')?.addEventListener('click', () => {
            const name = prompt('请输入新分类名称：');
            if (name) this._addCategory(name);
        });
    },

    renderList() {
        const container = document.getElementById('pm-list');
        if (!container) return;
        let filtered = PromptService.filterByCategory(this._activeCategory, this._prompts);
        filtered = PromptService.search(this._searchKeyword, filtered);
        filtered = PromptService.sortByRecent(filtered);

        if (filtered.length === 0) {
            container.innerHTML = `<div class="pm-empty">${this._prompts.length === 0 ? '还没有提示词，点击下方按钮添加' : '没有匹配的提示词'}</div>`;
            return;
        }

        container.innerHTML = filtered.map(p => `
            <div class="pm-item" data-id="${p.id}">
                <div class="pm-item-title">
                    ${p.favorite ? '<span class="pm-fav">★</span>' : ''}
                    <span>${escHtml(p.title)}</span>
                </div>
                <div class="pm-item-preview">${escHtml(p.content)}</div>
                <div class="pm-item-meta">
                    <div class="pm-item-tags">${(p.tags || []).map(t => `<span class="pm-tag">${escHtml(t)}</span>`).join('')}${(() => { const vars = parseTemplate(p.content); return vars.length > 0 ? vars.map(v => `<span class="pm-tag pm-var-tag">{${escHtml(v)}}</span>`).join('') : ''; })()}</div>
                    <div class="pm-item-actions">
                        <button class="pm-btn-fill" data-id="${p.id}" title="追加到输入框">${SVG.fill} 填入</button>
                        <button class="pm-btn-fill-send" data-id="${p.id}" title="填入并发送">${SVG.fill} 填入发送</button>
                        <button class="pm-btn-fav" data-id="${p.id}" title="${p.favorite ? '取消收藏' : '收藏'}">${p.favorite ? '☆' : '★'}</button>
                        <button class="pm-btn-edit" data-id="${p.id}">编辑</button>
                        <button class="pm-btn-del" data-id="${p.id}">删除</button>
                    </div>
                </div>
            </div>
        `).join('');

        container.querySelectorAll('.pm-btn-fill').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); this._fillPrompt(btn.dataset.id); }));
        container.querySelectorAll('.pm-btn-fill-send').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); this._fillAndSendPrompt(btn.dataset.id); }));
        container.querySelectorAll('.pm-btn-edit').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); this.showEditModal(btn.dataset.id); }));
        container.querySelectorAll('.pm-btn-del').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); this._deletePrompt(btn.dataset.id); }));
        container.querySelectorAll('.pm-btn-fav').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); this._toggleFavorite(btn.dataset.id); }));
    },

    async _fillPrompt(id) {
        const prompt = this._prompts.find(p => p.id === id);
        if (!prompt) return;
        let content = prompt.content;
        let replaced = false;
        const vars = parseTemplate(content);
        if (vars.length > 0) {
            const args = readArgsFromEditor();
            content = fillTemplate(content, args.named, args.positional);
            replaced = true;
        }
        const success = SiteAdapter.insertText(content, 'append');
        if (success) {
            prompt.usageCount = (prompt.usageCount || 0) + 1;
            prompt.updatedAt = new Date().toISOString();
            await StorageService.save(this._prompts);
            this.renderList();
            toast(replaced ? '已替换变量并追加到输入框' : '已追加到输入框，仍需手动发送');
        } else {
            toast('未找到输入框，请点击 ChatGPT 输入区域后再试');
        }
    },

    async _fillAndSendPrompt(id) {
        const prompt = this._prompts.find(p => p.id === id);
        if (!prompt) return;
        let content = prompt.content;
        const vars = parseTemplate(content);
        if (vars.length > 0) {
            const args = readArgsFromEditor();
            content = fillTemplate(content, args.named, args.positional);
        }
        const success = SiteAdapter.insertText(content, 'replace');
        if (!success) { toast('未找到输入框，请点击 ChatGPT 输入区域后再试'); return; }
        prompt.usageCount = (prompt.usageCount || 0) + 1;
        prompt.updatedAt = new Date().toISOString();
        await StorageService.save(this._prompts);
        this.renderList();
        toast('已填入，正在发送...');
        // Wait for React state to update the send button
        await new Promise(r => setTimeout(r, 300));
        const sendBtn = document.querySelector('.composer-submit-button-color');
        if (sendBtn && !sendBtn.disabled) {
            sendBtn.click();
        } else {
            toast('发送按钮未就绪，请手动点击发送');
        }
    },

    async _deletePrompt(id) {
        const prompt = this._prompts.find(p => p.id === id);
        if (!prompt) return;
        if (!confirm(`确定删除「${prompt.title}」？`)) return;
        this._prompts = this._prompts.filter(p => p.id !== id);
        await StorageService.save(this._prompts);
        this.renderList();
        this.renderCategories();
        toast('已删除');
    },

    async _toggleFavorite(id) {
        const prompt = this._prompts.find(p => p.id === id);
        if (!prompt) return;
        prompt.favorite = !prompt.favorite;
        prompt.updatedAt = new Date().toISOString();
        await StorageService.save(this._prompts);
        this.renderList();
    },

    async _handleImport(e) {
        const file = e.target.files[0];
        if (!file) return;
        e.target.value = '';
        try {
            StorageService.exportJSON(this._prompts);
            const imported = await StorageService.importJSON(file);
            const existingIds = new Set(this._prompts.map(p => p.id));
            let added = 0;
            for (const p of imported) { if (!existingIds.has(p.id)) { this._prompts.push(p); added++; } }
            await StorageService.save(this._prompts);
            this.renderList();
            toast(`已导入 ${added} 条提示词`);
        } catch(err) { toast('导入失败：' + err.message); }
    },

    showEditModal(id, prefill) {
        this._editingId = id || null;
        const prompt = id ? this._prompts.find(p => p.id === id) : null;
        const data = prompt || prefill || {};

        const overlay = document.createElement('div');
        overlay.className = 'pm-modal-overlay';
        overlay.innerHTML = `
            <div class="pm-modal">
                <h4>${prompt ? '编辑提示词' : '新增提示词'}</h4>
                <label>标题</label>
                <input id="pm-edit-title" type="text" value="${escHtml(data.title || '')}" placeholder="给提示词起个名字" />
                <label>内容</label>
                <textarea id="pm-edit-content" placeholder="输入提示词内容...">${escHtml(data.content || '')}</textarea>
                <div style="margin:-8px 0 12px;font-size:11px;color:#9ca3af">使用 {变量名} 定义占位符，{变量名='默认值'} 设置默认值。传参：'值' 按顺序，变量名='值' 按名称，'' 跳过</div>
                <label>分类</label>
                <select id="pm-edit-category">
                    ${this._getCategoryList().map(c => `<option value="${c}"${data.category === c ? ' selected' : ''}>${c}</option>`).join('')}
                </select>
                <label>标签（逗号分隔）</label>
                <input id="pm-edit-tags" type="text" value="${(data.tags || []).join(', ')}" placeholder="标签1, 标签2" />
                <div class="pm-modal-btns">
                    <button class="pm-btn-cancel" id="pm-edit-cancel">取消</button>
                    <button class="pm-btn-save" id="pm-edit-save">保存</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        setTimeout(() => document.getElementById('pm-edit-title')?.focus(), 50);
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
        document.getElementById('pm-edit-cancel').addEventListener('click', () => overlay.remove());
        document.getElementById('pm-edit-save').addEventListener('click', async () => { await this._savePrompt(overlay); });
        overlay.addEventListener('keydown', e => { if (e.ctrlKey && e.key === 'Enter') this._savePrompt(overlay); });
    },

    async _savePrompt(overlay) {
        const title = document.getElementById('pm-edit-title').value.trim();
        const content = document.getElementById('pm-edit-content').value.trim();
        const category = document.getElementById('pm-edit-category').value;
        const tagsStr = document.getElementById('pm-edit-tags').value.trim();
        const tags = tagsStr ? tagsStr.split(/[,，]/).map(t => t.trim()).filter(Boolean) : [];

        if (!title) { toast('请输入标题'); return; }
        if (!content) { toast('请输入提示词内容'); return; }

        if (this._editingId) {
            const idx = this._prompts.findIndex(p => p.id === this._editingId);
            if (idx !== -1) this._prompts[idx] = PromptService.update(this._prompts[idx], { title, content, category, tags });
        } else {
            this._prompts.push(PromptService.create({ title, content, category, tags }));
        }
        await StorageService.save(this._prompts);
        overlay.remove();
        this.renderList();
        this.renderCategories();
        toast(this._editingId ? '已更新' : '已添加');
    },
};

// ============================================================
// Section 15: SPA Monitoring
// ============================================================
let lastUrl = '';
function startMonitoring() {
    const checkUrl = () => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            allRounds = []; seenPrompts.clear();
            _userUploadedFileIds = new Set();
            lastFetchConvId = '';
            const rpBody = document.getElementById('rp-body'); if (rpBody) rpBody.innerHTML = '';
            updateFab(); updateExtractedFooter();
            if (activeTab === 'library') LibraryUI.render();
        }
    };
    setInterval(checkUrl, 1000);

    let debounce = null;
    const obs = new MutationObserver(() => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
            // Re-mount UI if removed
            if (!document.getElementById(Config.PANEL_ID)) { createFab(); createPanel(); }
            // Enrich images for extracted prompts
            const total = allRounds.reduce((s, r) => s + r.prompts.length, 0);
            if (total > 0) {
                const noImgCount = allRounds.flatMap(r => r.prompts).filter(p => p.imageUrls.length === 0).length;
                if (noImgCount > 0) {
                    const imgs = getAllDomImages(_userUploadedFileIds);
                    if (imgs.length > 0) { enrichWithDomImages(allRounds, null, _userUploadedFileIds); renderExtractedTab(); }
                }
            }
        }, 3000);
    });
    obs.observe(document.body, { childList: true, subtree: true });
}

// ============================================================
// Section 16: Bootstrap
// ============================================================
async function boot() {
    log('v' + Config.VERSION + ' 启动');
    injectStyles();
    await LibraryUI.init();
    createFab();
    createPanel();
    startMonitoring();

    if (getConversationId()) {
        log('当前对话:', getConversationId());
        updateFab();
    }
}

if (document.readyState === 'complete') boot();
else window.addEventListener('load', boot);

// Menu commands
GM_registerMenuCommand('打开提示词套件', () => togglePanel(true));
GM_registerMenuCommand('导出提示词备份', () => { StorageService.exportJSON(LibraryUI._prompts); toast('已导出'); });

})();
