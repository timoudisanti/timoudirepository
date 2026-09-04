import { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef } from "react";
import {
  Search, Plus, X, ChevronUp, ChevronDown, Trash2,
  Music2, Sparkles, ExternalLink, ListMusic, Check, ChevronRight,
  Link as LinkIcon, Pencil, ArrowLeft, Loader2, RefreshCw, ArrowUp, ArrowDown
} from "lucide-react";

/* ---------------------------------------------------------------
   Worshinotes — repertorio y setlists para músico de covers
   Base de Datos: Google Sheets vía Sheety (canciones y sesiones)
--------------------------------------------------------------- */

const SHEETY_URL = "https://api.sheety.co/de7aa6d77370429e866e19257dc685f0/worshinotesDb/sheet1";
const SHEETY_SESSIONS_URL = "https://api.sheety.co/de7aa6d77370429e866e19257dc685f0/worshinotesDb/sheet2";

const uid = () =>
  (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const normalize = (s) =>
  (s || "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

const todayISO = () => new Date().toISOString().slice(0, 10);

const formatDate = (iso) => {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
};

const TEMPO_LABEL = { rapida: "↑ Rápida", lenta: "↓ Lenta" };

const SECTION_TYPES = [
  { key: "intro", label: "Intro" },
  { key: "estrofa", label: "Estrofa" },
  { key: "precoro", label: "Precoro" },
  { key: "coro", label: "Coro" },
  { key: "puente", label: "Puente" },
  { key: "instrumental", label: "Instrumental" },
];
const SECTION_LABEL_BY_KEY = Object.fromEntries(SECTION_TYPES.map((t) => [t.key, t.label]));

async function aiSuggestNextGemini(prevSong, candidates, apiKey) {
  const pool = candidates.slice(0, 50);
  const list = pool
    .map((s) => `ID:${s.id}\nTítulo:${s.title}\nAutor:${s.author || "-"}\nLetra:${lyricsAsPlainText(s).slice(0, 400) || "(sin letra)"}`)
    .join("\n---\n");

  const prompt = `Sos un director musical armando el orden de un show en vivo.
La canción anterior fue "${prevSong.title}"${prevSong.author ? ` de ${prevSong.author}` : ""}.
Letra:
${lyricsAsPlainText(prevSong).slice(0, 600) || "(sin letra registrada)"}

Analizá el significado, el mensaje o la temática de esa letra y elegí la mejor canción de la siguiente lista de candidatas para continuar la sesión en vivo de manera fluida y con sentido temático:
${list}

Devolvé ÚNICAMENTE un JSON válido con esta estructura exacta (sin texto ni Markdown adicional):
{"songId": "ID_ELEGIDO", "reason": "una frase breve en español explicando la conexión temática"}`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json"
        }
      })
    }
  );

  if (!response.ok) throw new Error("No se pudo conectar con Gemini");
  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  return safeParseJSON(text);
}

function safeParseJSON(text) {
  try {
    if (!text) return null;
    if (typeof text === "object") return text;
    const cleaned = text.replace(/```json|```/g, "").trim();
    return JSON.parse(cleaned);
  } catch (e) {
    return null;
  }
}

function labelSections(sections) {
  const counters = {};
  return (sections || []).map((sec) => {
    counters[sec.type] = (counters[sec.type] || 0) + 1;
    const base = SECTION_LABEL_BY_KEY[sec.type] || sec.type;
    return { ...sec, label: `${base} ${counters[sec.type]}` };
  });
}

function displaySections(song) {
  if (song.sections?.length) return labelSections(song.sections);
  if (song.lyrics) return [{ id: "legacy", label: "Letra", content: song.lyrics }];
  return [];
}

function lyricsAsPlainText(song) {
  return displaySections(song).map((s) => `${s.label}\n${s.content}`).join("\n\n");
}

/* ---------------- Sheety API helpers ---------------- */

function parseSongFromSheety(row) {
  const parsedSections = safeParseJSON(row.sections);
  const parsedKeys = safeParseJSON(row.keys);

  return {
    id: row.id,
    title: row.title || "",
    author: row.author || "",
    keys: parsedKeys || [{ tono: row.keys || "", cantante: "" }],
    sections: parsedSections || (row.sections ? [{ id: "sheet-import", type: "estrofa", content: String(row.sections) }] : []),
    tempo: row.tempo || "rapida",
    youtube: row.youtube || "",
    createdAt: row.createdat || Date.now(),
  };
}

function formatSongForSheety(song) {
  return {
    sheet1: {
      title: song.title || "",
      author: song.author || "",
      keys: JSON.stringify(song.keys || []),
      sections: JSON.stringify(song.sections || []),
      tempo: song.tempo || "rapida",
      youtube: song.youtube || "",
      createdat: song.createdAt || Date.now(),
    }
  };
}

function parseSessionFromSheety(row) {
  return {
    id: row.id,
    title: row.title || "",
    date: row.date || todayISO(),
    songIds: safeParseJSON(row.songids) || safeParseJSON(row.songIds) || [],
    createdAt: row.createdat || Date.now(),
  };
}

function formatSessionForSheety(session) {
  return {
    sheet2: {
      title: session.title || "",
      date: session.date || todayISO(),
      songids: JSON.stringify(session.songIds || []),
      createdat: session.createdAt || Date.now(),
    }
  };
}

/* ---------------- Motor propio de coincidencias ---------------- */

const STOPWORDS_ES = new Set([
  "de","la","que","el","en","y","a","los","del","se","las","por","un","para","con","no","una",
  "su","al","lo","como","mas","pero","sus","le","ya","o","este","si","porque","esta","entre",
  "cuando","muy","sin","sobre","tambien","me","hasta","hay","donde","quien","desde","todo","nos",
  "durante","todos","uno","les","ni","contra","otros","ese","eso","ante","ellos","e","esto","mi",
  "antes","algunos","unos","yo","otro","otras","otra","tanto","esa","estos","mucho",
  "quienes","nada","muchos","cual","poco","ella","estar","estas","algunas","algo","nosotros",
  "mis","tu","te","ti","tus","ellas","nosotras","vosotros","vosotras","os","esos","esas","soy",
  "eres","es","somos","sois","son","sea","seas","seamos","sean","era","eras","eramos","eran",
  "fui","fuiste","fue","fuimos","fueron","he","has","ha","hemos","han","tener","tengo","tiene",
  "tienes","tenemos","tienen","tan","aqui","alli","ahi","asi","va","voy","vas","vamos",
  "van","ser","hacer","hace","hacia","solo","sola","fuera","sido","estoy","esta","estan",
  "cada","mismo","misma","mismos","dos","tres","aun","aunque","pues","bien",
]);

function significantWords(text) {
  return normalize(text)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS_ES.has(w));
}

function wordFrequency(words) {
  const map = new Map();
  for (const w of words) map.set(w, (map.get(w) || 0) + 1);
  return map;
}

function localSuggestNext(prevSong, candidates) {
  if (candidates.length === 0) return null;
  const prevWords = significantWords(lyricsAsPlainText(prevSong) || prevSong.title || "");
  if (prevWords.length === 0) {
    const song = candidates[Math.floor(Math.random() * candidates.length)];
    return { song, shared: [], reason: "La canción anterior no tiene letra cargada, así que elegimos esta al azar de tu repertorio." };
  }
  const prevSet = new Set(prevWords);
  let best = null;
  for (const c of candidates) {
    const cWords = significantWords(lyricsAsPlainText(c) || c.title || "");
    const shared = new Set();
    let score = 0;
    for (const w of cWords) {
      if (prevSet.has(w)) { score++; shared.add(w); }
    }
    if (!best || score > best.score) best = { song: c, score, shared: Array.from(shared) };
  }
  if (!best || best.score === 0) {
    const song = candidates[Math.floor(Math.random() * candidates.length)];
    return { song, shared: [], reason: "No encontramos palabras en común claras; te sugerimos esta al azar de tu repertorio." };
  }
  const top = best.shared.slice(0, 4);
  const reason = `Comparte palabras de la letra como ${top.map((w) => `"${w}"`).join(", ")} con la canción anterior.`;
  return { song: best.song, shared: top, reason };
}

function localThemeSearch(query, songs) {
  const qWords = significantWords(query);
  if (qWords.length === 0) return [];
  const scored = songs
    .map((s) => {
      const freq = wordFrequency(significantWords(lyricsAsPlainText(s)));
      let score = 0;
      for (const qw of qWords) {
        for (const [w, count] of freq) {
          if (w.includes(qw) || qw.includes(w)) score += count;
        }
      }
      return { id: s.id, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.map((x) => x.id);
}

/* ---------------- Small UI atoms ---------------- */

function Pill({ children }) {
  return <span className="pill">{children}</span>;
}

function Sheet({ title, onClose, children, footer }) {
  return (
    <div className="sheet-overlay" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-header">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Cerrar">
            <X size={20} />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-footer">{footer}</div>}
      </div>
    </div>
  );
}

function EmptyState({ icon, title, hint }) {
  return (
    <div className="empty-state">
      {icon}
      <p className="empty-title">{title}</p>
      {hint && <p className="empty-hint">{hint}</p>}
    </div>
  );
}

/* ---------------- Song Detail Viewer Sheet ---------------- */

function SongDetailSheet({ song, onClose, onEdit, onAddClick }) {
  const primary = song.keys?.[0];
  const fullTitle = `${song.title}${primary?.tono ? ` | ${primary.tono}` : ""}`;
  const sections = displaySections(song);

  return (
    <Sheet
      title={fullTitle}
      onClose={onClose}
      footer={
        <div className="footer-row">
          <button className="btn btn-secondary" onClick={() => onAddClick(song)}>
            <Plus size={16} /> Agregar a sesión
          </button>
          <div className="footer-spacer" />
          <button className="btn btn-primary" onClick={() => onEdit(song)}>
            <Pencil size={16} /> Editar
          </button>
        </div>
      }
    >
      <div className="session-row-meta" style={{ marginBottom: "12px" }}>
        <Pill>{TEMPO_LABEL[song.tempo]}</Pill>
        {(song.keys || []).map((k, i) => (
          k.tono && <Pill key={i}>{k.tono}{k.cantante ? ` · ${k.cantante}` : ""}</Pill>
        ))}
        {song.youtube && (
          <a className="yt-link" href={song.youtube} target="_blank" rel="noreferrer">
            <LinkIcon size={13} /> YouTube <ExternalLink size={11} />
          </a>
        )}
      </div>
      {song.author && <div className="song-author" style={{ fontSize: "14px", marginBottom: "16px" }}>{song.author}</div>}
      <div className="session-row-lyrics">
        {sections.length === 0 ? (
          <p className="lyrics-empty">Sin letra cargada.</p>
        ) : (
          sections.map((sec, i) => (
            <div className="lyrics-section" key={sec.id || i}>
              <div className="lyrics-section-label">{sec.label}</div>
              <pre className="lyrics-section-content">{sec.content || "(vacío)"}</pre>
            </div>
          ))
        )}
      </div>
    </Sheet>
  );
}

/* ---------------- Song Form ---------------- */

function emptyKey() {
  return { tono: "", cantante: "" };
}

function SongForm({ initial, onSave, onDelete, onClose }) {
  const isEdit = !!initial;
  const [title, setTitle] = useState(initial?.title || "");
  const [author, setAuthor] = useState(initial?.author || "");
  const [keys, setKeys] = useState(
    initial?.keys?.length ? initial.keys.map((k) => ({ ...k })) : [emptyKey()]
  );
  const [sections, setSections] = useState(
    initial?.sections?.length
      ? initial.sections.map((s) => ({ ...s }))
      : initial?.lyrics
      ? [{ id: uid(), type: "estrofa", content: initial.lyrics }]
      : []
  );
  const [tempo, setTempo] = useState(initial?.tempo || "rapida");
  const [youtube, setYoutube] = useState(initial?.youtube || "");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  const addAltKey = () => { if (keys.length < 3) setKeys([...keys, emptyKey()]); };
  const removeAltKey = (idx) => setKeys(keys.filter((_, i) => i !== idx));
  const updateKey = (idx, field, value) => {
    setKeys(keys.map((k, i) => (i === idx ? { ...k, [field]: value } : k)));
  };

  const addSection = (type) => setSections([...sections, { id: uid(), type, content: "" }]);
  const updateSectionContent = (idx, value) =>
    setSections(sections.map((s, i) => (i === idx ? { ...s, content: value } : s)));
  const removeSection = (idx) => setSections(sections.filter((_, i) => i !== idx));
  const moveSection = (idx, dir) => {
    const next = [...sections];
    const j = idx + dir;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    setSections(next);
  };
  const labeledSections = labelSections(sections);

  const handleSave = async () => {
    if (!title.trim()) { setErr("Poné al menos un título."); return; }
    if (!keys[0]?.tono?.trim()) { setErr("Poné el tono principal."); return; }
    setSaving(true);
    const cleanKeys = keys.filter((k, i) => i === 0 || k.tono.trim());
    await onSave({
      id: initial?.id,
      title: title.trim(),
      author: author.trim(),
      keys: cleanKeys.map((k) => ({ tono: k.tono.trim(), cantante: k.cantante.trim() })),
      sections: sections.map((s) => ({ id: s.id, type: s.type, content: s.content })),
      tempo,
      youtube: youtube.trim(),
      createdAt: initial?.createdAt || Date.now(),
    });
    setSaving(false);
  };

  return (
    <Sheet
      title={isEdit ? "Editar canción" : "Nueva canción"}
      onClose={onClose}
      footer={
        <div className="footer-row">
          {isEdit && (
            <button className="btn btn-danger" onClick={() => onDelete(initial.id)} disabled={saving}>
              <Trash2 size={16} /> Eliminar
            </button>
          )}
          <div className="footer-spacer" />
          <button className="btn btn-ghost" onClick={onClose} disabled={saving}>Cancelar</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="spin" size={16} /> : "Guardar"}
          </button>
        </div>
      }
    >
      {err && <div className="form-error">{err}</div>}

      <label className="field">
        <span>Título</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Nombre de la canción" />
      </label>

      <label className="field">
        <span>Autor</span>
        <input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="Autor / banda original" />
      </label>

      <div className="keys-block">
        {keys.map((k, idx) => (
          <div className="key-row" key={idx}>
            <div className="key-row-label">
              {idx === 0 ? "Tono principal" : `Tono alternativo ${idx}`}
              {idx > 0 && <button className="link-btn" onClick={() => removeAltKey(idx)}>quitar</button>}
            </div>
            <div className="key-row-fields">
              <input
                className="key-tono"
                placeholder="Tono (ej. C)"
                value={k.tono}
                onChange={(e) => updateKey(idx, "tono", e.target.value)}
              />
              <input
                className="key-singer"
                placeholder="Quién la canta"
                value={k.cantante}
                onChange={(e) => updateKey(idx, "cantante", e.target.value)}
              />
            </div>
          </div>
        ))}
        {keys.length < 3 && (
          <button className="link-btn add-key" onClick={addAltKey}>
            <Plus size={14} /> Agregar tono alternativo
          </button>
        )}
      </div>

      <label className="field">
        <span>Ritmo</span>
        <div className="segmented">
          <button className={tempo === "rapida" ? "seg-active" : ""} onClick={() => setTempo("rapida")} type="button">Rápida</button>
          <button className={tempo === "lenta" ? "seg-active" : ""} onClick={() => setTempo("lenta")} type="button">Lenta</button>
        </div>
      </label>

      <label className="field">
        <span>Link de YouTube</span>
        <input value={youtube} onChange={(e) => setYoutube(e.target.value)} placeholder="https://youtube.com/..." />
      </label>

      <div className="field">
        <span>Letra, por secciones</span>
        <div className="sections-block">
          {labeledSections.length === 0 && (
            <p className="sections-empty">Todavía no agregaste ninguna sección.</p>
          )}
          {labeledSections.map((sec, idx) => (
            <div className="section-item" key={sec.id}>
              <div className="section-item-head">
                <span className="section-item-label">{sec.label}</span>
                <div className="section-item-controls">
                  <button className="icon-btn tiny" disabled={idx === 0} onClick={() => moveSection(idx, -1)} aria-label="Subir sección">
                    <ArrowUp size={14} />
                  </button>
                  <button className="icon-btn tiny" disabled={idx === labeledSections.length - 1} onClick={() => moveSection(idx, 1)} aria-label="Bajar sección">
                    <ArrowDown size={14} />
                  </button>
                  <button className="icon-btn tiny danger" onClick={() => removeSection(idx)} aria-label="Quitar sección">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              <textarea
                rows={4}
                value={sec.content}
                onChange={(e) => updateSectionContent(idx, e.target.value)}
                placeholder={`Texto de ${sec.label.toLowerCase()}...`}
              />
            </div>
          ))}
          <div className="add-section-row">
            {SECTION_TYPES.map((t) => (
              <button className="btn btn-secondary" key={t.key} onClick={() => addSection(t.key)}>
                <Plus size={14} /> {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </Sheet>
  );
}

/* ---------------- Song row (list) ---------------- */

function SongRow({ song, onView, onAddClick }) {
  const primary = song.keys?.[0];
  return (
    <div className="song-row">
      <button className="song-row-main" onClick={() => onView(song)}>
        <div className="song-row-top">
          <span className="song-title">
            {song.title}
            {primary?.tono ? <span className="song-tono"> | {primary.tono}</span> : null}
          </span>
        </div>
        <div className="song-row-bottom">
          <span className="song-author">{song.author || "Autor desconocido"}</span>
          {primary?.cantante && <span className="song-singer">· canta {primary.cantante}</span>}
          <Pill>{TEMPO_LABEL[song.tempo]}</Pill>
        </div>
      </button>
      <button className="icon-btn add-btn" onClick={() => onAddClick(song)} aria-label="Agregar a sesión">
        <Plus size={18} />
      </button>
    </div>
  );
}

/* ---------------- Add-to-session picker ---------------- */

function AddToSessionSheet({ song, sessions, onClose, onCreateNew, onAddToExisting }) {
  return (
    <Sheet title={`Agregar "${song.title}"`} onClose={onClose}>
      <button className="option-row" onClick={() => onCreateNew(song)}>
        <div className="option-icon"><Plus size={16} /></div>
        <div>
          <div className="option-title">Nueva sesión</div>
          <div className="option-sub">Crear una sesión con esta canción</div>
        </div>
        <ChevronRight size={16} className="option-chevron" />
      </button>
      {sessions.length > 0 && <div className="sheet-divider">Sesiones existentes</div>}
      {sessions
        .slice()
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        .map((s) => (
          <button className="option-row" key={s.id} onClick={() => onAddToExisting(s.id, song)}>
            <div className="option-icon"><ListMusic size={16} /></div>
            <div>
              <div className="option-title">{s.title || formatDate(s.date)}</div>
              <div className="option-sub">{s.songIds.length} canción{s.songIds.length !== 1 ? "es" : ""} · {formatDate(s.date)}</div>
            </div>
            <ChevronRight size={16} className="option-chevron" />
          </button>
        ))}
    </Sheet>
  );
}

/* ---------------- Search sheet (reusable) ---------------- */

function SearchSheet({ songs, onClose, onPick, excludeIds = [] }) {
  const [q, setQ] = useState("");
  const results = useMemo(() => {
    const nq = normalize(q);
    const pool = songs.filter((s) => !excludeIds.includes(s.id));
    if (!nq) return pool;
    return pool.filter((s) => {
      const haystack = [
        s.title, s.author,
        ...(s.keys || []).map((k) => k.tono),
        ...(s.keys || []).map((k) => k.cantante),
      ].map(normalize).join(" ");
      return haystack.includes(nq);
    });
  }, [q, songs, excludeIds]);

  return (
    <Sheet title="Buscar canción" onClose={onClose}>
      <div className="search-bar">
        <Search size={16} />
        <input autoFocus placeholder="Título, autor, tono, quién canta..." value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {results.length === 0 ? (
        <EmptyState icon={<Search size={28} />} title="Sin resultados" hint="Probá con otra palabra" />
      ) : (
        <div className="pick-list">
          {results.map((s) => (
            <button className="option-row" key={s.id} onClick={() => onPick(s)}>
              <div className="option-icon"><Music2 size={16} /></div>
              <div>
                <div className="option-title">{s.title}{s.keys?.[0]?.tono ? ` | ${s.keys[0].tono}` : ""}</div>
                <div className="option-sub">{s.author || "Autor desconocido"}</div>
              </div>
              <ChevronRight size={16} className="option-chevron" />
            </button>
          ))}
        </div>
      )}
    </Sheet>
  );
}

/* ---------------- Session song row ---------------- */

function SessionSongRow({ song, number, expanded, dragging }) {
  const primary = song.keys?.[0];
  const sections = displaySections(song);
  return (
    <div className={`session-row${dragging ? " session-row-dragging" : ""}`}>
      <div className="session-row-head">
        <div className="session-number">{number}</div>
        <div className="session-row-title-btn">
          <div>
            <div className="session-title-line">
              {song.title}{primary?.tono ? <span className="session-tono"> | {primary.tono}</span> : null}
            </div>
            <div className="session-author-line">{song.author || "Autor desconocido"}</div>
          </div>
          {expanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </div>
      </div>
      {expanded && (
        <div className="session-row-body">
          <div className="session-row-meta">
            <Pill>{TEMPO_LABEL[song.tempo]}</Pill>
            {(song.keys || []).map((k, i) => (
              k.tono && <Pill key={i}>{k.tono}{k.cantante ? ` · ${k.cantante}` : ""}</Pill>
            ))}
            {song.youtube && (
              <a className="yt-link" href={song.youtube} target="_blank" rel="noreferrer" onPointerDown={(e) => e.stopPropagation()}>
                <LinkIcon size={13} /> YouTube <ExternalLink size={11} />
              </a>
            )}
          </div>
          <div className="session-row-lyrics">
            {sections.length === 0 ? (
              <p className="lyrics-empty">Sin letra cargada.</p>
            ) : (
              sections.map((sec, i) => (
                <div className="lyrics-section" key={sec.id || i}>
                  <div className="lyrics-section-label">{sec.label}</div>
                  <pre className="lyrics-section-content">{sec.content || "(vacío)"}</pre>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- Swipe-to-delete genérico ---------------- */

const REVEAL_WIDTH = 84;
const SWIPE_START_PX = 8;

function SwipeToDeleteRow({ id, openId, setOpenId, onDelete, onTap, children }) {
  const [liveX, setLiveX] = useState(null);
  const gestureRef = useRef(null);
  const isOpen = openId === id;
  const committedX = isOpen ? -REVEAL_WIDTH : 0;
  const x = liveX !== null ? liveX : committedX;

  const onPointerDown = (e) => {
    if (openId && openId !== id) setOpenId(null);
    gestureRef.current = { startX: e.clientX, startY: e.clientY, mode: "pending" };
  };
  const onPointerMove = (e) => {
    const g = gestureRef.current;
    if (!g) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (g.mode === "pending") {
      if (Math.abs(dx) > SWIPE_START_PX && Math.abs(dx) > Math.abs(dy)) g.mode = "swiping";
      else if (Math.hypot(dx, dy) > SWIPE_START_PX) g.mode = "scrolling";
    }
    if (g.mode === "swiping") {
      const base = isOpen ? -REVEAL_WIDTH : 0;
      setLiveX(Math.max(-REVEAL_WIDTH, Math.min(0, base + dx)));
    }
  };
  const onPointerUp = () => {
    const g = gestureRef.current;
    gestureRef.current = null;
    if (!g) return;
    if (g.mode === "swiping") {
      const finalX = liveX !== null ? liveX : committedX;
      setOpenId(finalX <= -REVEAL_WIDTH / 2 ? id : null);
      setLiveX(null);
    } else if (g.mode === "pending") {
      if (isOpen) setOpenId(null);
      else onTap?.();
    } else {
      setLiveX(null);
    }
  };
  const onPointerCancel = () => { gestureRef.current = null; setLiveX(null); };

  return (
    <div className="swipe-track">
      <button className="swipe-delete-bg" onClick={onDelete} aria-label="Eliminar">
        <Trash2 size={18} />
      </button>
      <div
        className="swipe-content"
        style={{ transform: `translateX(${x}px)`, transition: liveX !== null ? "none" : "transform 200ms ease" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        {children}
      </div>
    </div>
  );
}

/* ---------------- Session song list ---------------- */

const LONG_PRESS_MS = 400;
const MOVE_CANCEL_PX = 18;
const ROW_GAP = 8;

function SessionSongList({ songs, onReorderCommit, expandedRowId, onToggleRow, onRemove }) {
  const [order, setOrder] = useState(() => songs.map((s) => s.id));
  useEffect(() => { setOrder(songs.map((s) => s.id)); }, [songs]);

  const idToSong = useMemo(() => Object.fromEntries(songs.map((s) => [s.id, s])), [songs]);
  const orderedSongs = order.map((id) => idToSong[id]).filter(Boolean);

  const containerRef = useRef(null);
  const rowRefs = useRef({});
  const timersRef = useRef({});
  const gestureRef = useRef({});
  const prevRectsRef = useRef(null);

  const [dragState, setDragState] = useState(null);
  const [openSwipeId, setOpenSwipeId] = useState(null);
  const [liveSwipe, setLiveSwipe] = useState(null);

  useLayoutEffect(() => {
    const firstRects = prevRectsRef.current;
    if (!firstRects) return;
    prevRectsRef.current = null;
    Object.keys(firstRects).forEach((id) => {
      const node = rowRefs.current[id];
      if (!node) return;
      const first = firstRects[id];
      const last = node.getBoundingClientRect();
      const dy = first.top - last.top;
      if (dy) {
        node.style.transition = "none";
        node.style.transform = `translateY(${dy}px)`;
        requestAnimationFrame(() => {
          node.style.transition = "transform 220ms ease";
          node.style.transform = "";
        });
      }
    });
  }, [order]);

  const clearTimerFor = (id) => {
    if (timersRef.current[id]) { clearTimeout(timersRef.current[id]); delete timersRef.current[id]; }
  };

  const startDrag = (id, targetEl, pointerId) => {
    const node = rowRefs.current[id];
    if (!node) return;
    onToggleRow(null);
    setOpenSwipeId(null);
    if (targetEl && targetEl.setPointerCapture) {
      try { targetEl.setPointerCapture(pointerId); } catch (err) {}
    }
    const rect = node.getBoundingClientRect();
    setDragState({ id, top: rect.top, left: rect.left, width: rect.width, height: rect.height, translateY: 0 });
    if (typeof navigator !== "undefined" && navigator.vibrate) {
      try { navigator.vibrate(12); } catch (e) { /* no soportado */ }
    }
  };

  const handlePointerDown = (id, e) => {
    if (dragState) return;
    if (openSwipeId && openSwipeId !== id) setOpenSwipeId(null);
    const targetEl = e.currentTarget;
    const pointerId = e.pointerId;
    gestureRef.current[id] = { mode: "pending", startX: e.clientX, startY: e.clientY, targetEl, pointerId };
    clearTimerFor(id);
    timersRef.current[id] = setTimeout(() => {
      const g = gestureRef.current[id];
      if (g && g.mode === "pending") {
        g.mode = "dragging-vertical";
        startDrag(id, targetEl, pointerId);
      }
    }, LONG_PRESS_MS);
  };

  const handlePointerMove = (id, e) => {
    const g = gestureRef.current[id];
    if (!g) return;

    if (g.mode === "dragging-vertical") {
      if (!dragState || dragState.id !== id) return;
      const dy = e.clientY - g.startY;
      const container = containerRef.current;
      if (container) {
        const containerTop = container.getBoundingClientRect().top;
        const step = dragState.height + ROW_GAP;
        const currentTop = dragState.top + dy;
        let targetIndex = Math.round((currentTop - containerTop) / step);
        targetIndex = Math.max(0, Math.min(order.length - 1, targetIndex));
        const currentIndex = order.indexOf(id);
        if (targetIndex !== currentIndex) {
          const firstRects = {};
          order.forEach((oid) => {
            if (oid === id) return;
            const node = rowRefs.current[oid];
            if (node) firstRects[oid] = node.getBoundingClientRect();
          });
          prevRectsRef.current = firstRects;
          const next = [...order];
          next.splice(currentIndex, 1);
          next.splice(targetIndex, 0, id);
          setOrder(next);
        }
      }
      setDragState((d) => (d ? { ...d, translateY: dy } : d));
      return;
    }

    if (g.mode === "swiping-horizontal") {
      const dx = e.clientX - g.startX;
      const base = openSwipeId === id ? -REVEAL_WIDTH : 0;
      setLiveSwipe({ id, x: Math.max(-REVEAL_WIDTH, Math.min(0, base + dx)) });
      return;
    }

    if (g.mode === "pending") {
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;
      if (Math.abs(dx) > MOVE_CANCEL_PX && Math.abs(dx) > Math.abs(dy)) {
        g.mode = "swiping-horizontal";
        clearTimerFor(id);
        const base = openSwipeId === id ? -REVEAL_WIDTH : 0;
        setLiveSwipe({ id, x: Math.max(-REVEAL_WIDTH, Math.min(0, base + dx)) });
      } else if (Math.hypot(dx, dy) > MOVE_CANCEL_PX) {
        g.mode = "scrolling";
        clearTimerFor(id);
      }
    }
  };

  const handlePointerUp = (id, e) => {
    const g = gestureRef.current[id];
    clearTimerFor(id);
    delete gestureRef.current[id];
    if (!g) return;

    if (g.mode === "dragging-vertical") {
      if (e.currentTarget && e.currentTarget.releasePointerCapture) {
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) {}
      }
      setDragState(null);
      onReorderCommit(order);
      return;
    }
    if (g.mode === "swiping-horizontal") {
      const x = liveSwipe && liveSwipe.id === id ? liveSwipe.x : (openSwipeId === id ? -REVEAL_WIDTH : 0);
      setOpenSwipeId(x <= -REVEAL_WIDTH / 2 ? id : null);
      setLiveSwipe(null);
      return;
    }
    if (g.mode === "pending") {
      if (openSwipeId === id) setOpenSwipeId(null);
      else onToggleRow(id);
    }
  };

  const handlePointerCancel = (id) => {
    clearTimerFor(id);
    delete gestureRef.current[id];
    if (dragState && dragState.id === id) setDragState(null);
    if (liveSwipe && liveSwipe.id === id) setLiveSwipe(null);
  };

  return (
    <div className="session-song-list" ref={containerRef}>
      {orderedSongs.map((s, i) => {
        const isDragging = dragState?.id === s.id;
        const isLiveSwiping = liveSwipe?.id === s.id;
        const swipeX = isLiveSwiping ? liveSwipe.x : (openSwipeId === s.id ? -REVEAL_WIDTH : 0);
        return (
          <div
            key={s.id}
            ref={(el) => { rowRefs.current[s.id] = el; }}
            className="session-row-wrap"
            style={
              isDragging
                ? { position: "fixed", top: dragState.top + dragState.translateY, left: dragState.left, width: dragState.width, zIndex: 1000, opacity: 0.55, touchAction: "none" }
                : undefined
            }
          >
            <div className="swipe-track">
              <button className="swipe-delete-bg" onClick={() => onRemove(s.id)} aria-label="Eliminar canción de la sesión">
                <Trash2 size={18} />
              </button>
              <div
                className="swipe-content"
                onPointerDown={(e) => handlePointerDown(s.id, e)}
                onPointerMove={(e) => handlePointerMove(s.id, e)}
                onPointerUp={(e) => handlePointerUp(s.id, e)}
                onPointerCancel={() => handlePointerCancel(s.id)}
                style={{ transform: `translateX(${swipeX}px)`, transition: isLiveSwiping ? "none" : "transform 200ms ease" }}
              >
                <SessionSongRow song={s} number={i + 1} expanded={expandedRowId === s.id} dragging={isDragging} />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ---------------- Main App ---------------- */

export default function App() {
  const [loaded, setLoaded] = useState(false);
  const [songs, setSongs] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [error, setError] = useState("");

  const [tab, setTab] = useState("songs");

  const [query, setQuery] = useState("");
  const [searchType, setSearchType] = useState("todo");
  const [sortBy, setSortBy] = useState("titulo");

  const [viewingSong, setViewingSong] = useState(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingSong, setEditingSong] = useState(null);
  const [addSheetSong, setAddSheetSong] = useState(null);

  const [activeSessionId, setActiveSessionId] = useState(null);
  const [openSwipeSessionId, setOpenSwipeSessionId] = useState(null);
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [sessionAddMenuOpen, setSessionAddMenuOpen] = useState(false);
  const [expandedRowId, setExpandedRowId] = useState(null);
  const [suggest, setSuggest] = useState(null);
  const [editingTitle, setEditingTitle] = useState(false);

  /* ---- Sheety API loads ---- */
  const loadSongs = useCallback(async () => {
    try {
      const res = await fetch(SHEETY_URL);
      if (!res.ok) throw new Error("Error de conexión a canciones");
      const data = await res.json();
      const list = (data.sheet1 || []).map(parseSongFromSheety);
      setSongs(list);
    } catch (e) {
      setError("No se pudieron cargar las canciones de Google Sheets.");
    } finally {
      setLoaded(true);
    }
  }, []);

  const loadSessions = useCallback(async () => {
    try {
      const res = await fetch(SHEETY_SESSIONS_URL);
      if (!res.ok) throw new Error("Error de conexión a sesiones");
      const data = await res.json();
      const rawList = data.sheet2 || data.sheet2s || data.sessions || data.sesiones || [];
      const list = rawList.map(parseSessionFromSheety);
      setSessions(list);
    } catch (e) {
      try {
        const stored = localStorage.getItem("worshinotes:sessions");
        if (stored) setSessions(JSON.parse(stored));
      } catch (err) {}
    }
  }, []);

  useEffect(() => {
    loadSongs();
    loadSessions();
  }, [loadSongs, loadSessions]);

  /* ---- Sheety Sessions CRUD ---- */
  const persistSessionsLocally = (next) => {
    setSessions(next);
    localStorage.setItem("worshinotes:sessions", JSON.stringify(next));
  };

  const saveSong = async (song) => {
    try {
      const isEdit = !!song.id;
      const body = formatSongForSheety(song);
      const url = isEdit ? `${SHEETY_URL}/${song.id}` : SHEETY_URL;
      const method = isEdit ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) throw new Error("Error al guardar canción");
      await loadSongs();
      setFormOpen(false);
      setEditingSong(null);
    } catch (e) {
      setError("No se pudo guardar la canción en Google Sheets.");
    }
  };

  const deleteSong = async (id) => {
    try {
      const res = await fetch(`${SHEETY_URL}/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Error al eliminar canción");
      await loadSongs();
      setFormOpen(false);
      setEditingSong(null);
    } catch (e) {
      setError("No se pudo eliminar la canción.");
    }
  };

  const createSession = async (firstSong) => {
    const newSession = {
      title: "",
      date: todayISO(),
      songIds: firstSong ? [firstSong.id] : [],
      createdAt: Date.now(),
    };

    try {
      const res = await fetch(SHEETY_SESSIONS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formatSessionForSheety(newSession)),
      });

      if (res.ok) {
        const data = await res.json();
        const createdRow = data.sheet2 || data.session;
        const createdSession = parseSessionFromSheety(createdRow);
        const next = [...sessions, createdSession];
        persistSessionsLocally(next);
        setActiveSessionId(createdSession.id);
      } else {
        throw new Error();
      }
    } catch (e) {
      const fallbackSession = { ...newSession, id: uid() };
      const next = [...sessions, fallbackSession];
      persistSessionsLocally(next);
      setActiveSessionId(fallbackSession.id);
    }

    setTab("sessions");
    setAddSheetSong(null);
  };

  const updateActiveSession = async (patch) => {
    if (!activeSession) return;
    const updated = { ...activeSession, ...patch };
    const nextSessions = sessions.map((s) => (s.id === activeSession.id ? updated : s));
    persistSessionsLocally(nextSessions);

    if (typeof activeSession.id === "number" || !isNaN(Number(activeSession.id))) {
      try {
        await fetch(`${SHEETY_SESSIONS_URL}/${activeSession.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(formatSessionForSheety(updated)),
        });
      } catch (e) {}
    }
  };

  const addSongToSession = async (sessionId, song) => {
    const targetSession = sessions.find((s) => s.id === sessionId);
    if (!targetSession) return;
    const updated = { ...targetSession, songIds: [...targetSession.songIds, song.id] };
    const nextSessions = sessions.map((s) => (s.id === sessionId ? updated : s));
    persistSessionsLocally(nextSessions);
    setAddSheetSong(null);

    if (typeof sessionId === "number" || !isNaN(Number(sessionId))) {
      try {
        await fetch(`${SHEETY_SESSIONS_URL}/${sessionId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(formatSessionForSheety(updated)),
        });
      } catch (e) {}
    }
  };

  const deleteSession = async (id) => {
    const nextSessions = sessions.filter((s) => s.id !== id);
    persistSessionsLocally(nextSessions);
    if (activeSessionId === id) setActiveSessionId(null);

    if (typeof id === "number" || !isNaN(Number(id))) {
      try {
        await fetch(`${SHEETY_SESSIONS_URL}/${id}`, { method: "DELETE" });
      } catch (e) {}
    }
  };

  /* ---- filtering & sorting ---- */
  const filteredSongs = useMemo(() => {
    if (searchType === "tema") {
      const nq = query.trim();
      if (!nq) return songs;
      const ids = localThemeSearch(nq, songs);
      const order = new Map(ids.map((id, i) => [id, i]));
      return songs.filter((s) => order.has(s.id)).sort((a, b) => order.get(a.id) - order.get(b.id));
    }
    const nq = normalize(query);
    if (!nq) return songs;
    return songs.filter((s) => {
      let haystack = "";
      if (searchType === "todo") {
        haystack = [s.title, s.author, ...(s.keys || []).map((k) => k.tono), ...(s.keys || []).map((k) => k.cantante)].join(" ");
      } else if (searchType === "titulo") haystack = s.title;
      else if (searchType === "autor") haystack = s.author;
      else if (searchType === "tono") haystack = (s.keys || []).map((k) => k.tono).join(" ");
      else if (searchType === "cantante") haystack = (s.keys || []).map((k) => k.cantante).join(" ");
      return normalize(haystack).includes(nq);
    });
  }, [songs, query, searchType]);

  const sortedSongs = useMemo(() => {
    if (searchType === "tema" && query.trim()) return filteredSongs;
    const arr = [...filteredSongs];
    arr.sort((a, b) => {
      if (sortBy === "titulo") return a.title.localeCompare(b.title, "es");
      if (sortBy === "autor") return (a.author || "").localeCompare(b.author || "", "es");
      if (sortBy === "tono") return (a.keys?.[0]?.tono || "").localeCompare(b.keys?.[0]?.tono || "", "es");
      if (sortBy === "cantante") return (a.keys?.[0]?.cantante || "").localeCompare(b.keys?.[0]?.cantante || "", "es");
      if (sortBy === "tempo") return (a.tempo || "").localeCompare(b.tempo || "");
      return 0;
    });
    return arr;
  }, [filteredSongs, sortBy, searchType, query]);

  const activeSession = sessions.find((s) => s.id === activeSessionId) || null;
  const activeSessionSongs = useMemo(() => {
    if (!activeSession) return [];
    return activeSession.songIds.map((id) => songs.find((s) => s.id === id)).filter(Boolean);
  }, [activeSession, songs]);

  const reorderSession = (newIds) => updateActiveSession({ songIds: newIds });

  const removeSongFromSession = (id) => {
    updateActiveSession({ songIds: activeSession.songIds.filter((sid) => sid !== id) });
  };

  const addSongToActiveSession = (song) => {
    updateActiveSession({ songIds: [...activeSession.songIds, song.id] });
    setSessionSearchOpen(false);
    setSessionAddMenuOpen(false);
    setSuggest(null);
  };

  // Reemplazá TU_API_KEY_AQUÍ por la clave de Google AI Studio o usá import.meta.env.VITE_GEMINI_API_KEY
const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY;

const runSuggest = async () => {
  setSessionAddMenuOpen(false);
  const prev = activeSessionSongs[activeSessionSongs.length - 1];
  if (!prev) return;

  const candidates = songs.filter((s) => !activeSession.songIds.includes(s.id));
  if (candidates.length === 0) {
    setSuggest({ result: null, error: "No hay más canciones en tu repertorio para sugerir." });
    return;
  }

  setSuggest({ loading: true, result: null, error: "" });

  try {
    if (GEMINI_API_KEY && GEMINI_API_KEY !== "TU_API_KEY_AQUÍ") {
      const res = await aiSuggestNextGemini(prev, candidates, GEMINI_API_KEY);
      const song = res?.songId ? songs.find((s) => String(s.id) === String(res.songId)) : null;
      
      if (song) {
        setSuggest({ result: { song, reason: res.reason || "Recomendada por temática." }, error: "" });
        return;
      }
    }
    throw new Error("Usar respaldo local");
  } catch (e) {
    // Respaldo inteligente local si falla la red o no hay clave
    const res = localSuggestNext(prev, candidates);
    if (res) {
      setSuggest({ result: res, error: "" });
    } else {
      setSuggest({ result: null, error: "No se pudo generar una sugerencia." });
    }
  }
};

  return (
    <div className="app">
      <style>{CSS}</style>

      <header className="app-header">
        <div className="staff-lines" aria-hidden="true"><span /><span /><span /></div>
        <h1 className="wordmark">Worshinotes</h1>
        <button className="icon-btn refresh-icon" onClick={() => { loadSongs(); loadSessions(); }} title="Actualizar datos">
          <RefreshCw size={16} />
        </button>
      </header>

      {error && (
        <div className="banner-error" onClick={() => setError("")}>
          {error} <span className="banner-dismiss">✕</span>
        </div>
      )}

      <main className="app-main">
        {!loaded ? (
          <EmptyState icon={<Loader2 className="spin" size={28} />} title="Cargando tu repertorio desde Google Sheets..." />
        ) : tab === "songs" ? (
          <div className="songs-view">
            <div className="search-bar">
              <Search size={16} />
              <input
                placeholder="Buscar canciones..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && (
                <button className="icon-btn tiny" onClick={() => setQuery("")}>
                  <X size={14} />
                </button>
              )}
            </div>

            <div className="filter-row">
              <select value={searchType} onChange={(e) => setSearchType(e.target.value)}>
                <option value="todo">Buscar en todo</option>
                <option value="titulo">Por título</option>
                <option value="autor">Por autor</option>
                <option value="tono">Por tono</option>
                <option value="cantante">Por quién canta</option>
                <option value="tema">Por tema (busca en la letra)</option>
              </select>

              {searchType !== "tema" && (
                <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                  <option value="titulo">Ordenar: título</option>
                  <option value="autor">Ordenar: autor</option>
                  <option value="tono">Ordenar: tono</option>
                  <option value="cantante">Ordenar: quién canta</option>
                  <option value="tempo">Ordenar: ritmo</option>
                </select>
              )}
            </div>

            {sortedSongs.length === 0 ? (
              <EmptyState
                icon={<Music2 size={28} />}
                title={songs.length === 0 ? "Todavía no cargaste canciones" : "Sin resultados"}
                hint={songs.length === 0 ? "Tocá el botón + para agregar tu primera canción" : "Probá con otra búsqueda"}
              />
            ) : (
              <div className="song-list">
                {sortedSongs.map((s) => (
                  <SongRow
                    key={s.id}
                    song={s}
                    onView={(song) => setViewingSong(song)}
                    onAddClick={(song) => setAddSheetSong(song)}
                  />
                ))}
              </div>
            )}

            <button className="fab" onClick={() => { setEditingSong(null); setFormOpen(true); }} aria-label="Nueva canción">
              <Plus size={24} />
            </button>
          </div>
        ) : activeSession ? (
          <div className="session-editor">
            <div className="session-editor-header">
              <button className="icon-btn" onClick={() => { setActiveSessionId(null); setSuggest(null); setExpandedRowId(null); }}>
                <ArrowLeft size={20} />
              </button>
              <div className="session-editor-titlebox">
                {editingTitle ? (
                  <input
                    autoFocus
                    className="session-title-input"
                    placeholder={formatDate(activeSession.date)}
                    value={activeSession.title}
                    onChange={(e) => updateActiveSession({ title: e.target.value })}
                    onBlur={() => setEditingTitle(false)}
                    onKeyDown={(e) => e.key === "Enter" && setEditingTitle(false)}
                  />
                ) : (
                  <button className="session-title-display" onClick={() => setEditingTitle(true)}>
                    {activeSession.title || formatDate(activeSession.date)} <Pencil size={13} />
                  </button>
                )}
                <input type="date" className="session-date-input" value={activeSession.date} onChange={(e) => updateActiveSession({ date: e.target.value })} />
              </div>
              <button className="icon-btn danger" onClick={() => deleteSession(activeSession.id)} aria-label="Eliminar sesión">
                <Trash2 size={18} />
              </button>
            </div>

            {activeSessionSongs.length === 0 ? (
              <EmptyState icon={<ListMusic size={28} />} title="Sesión vacía" hint="Agregá la primera canción para empezar el show" />
            ) : (
              <SessionSongList
                songs={activeSessionSongs}
                onReorderCommit={reorderSession}
                expandedRowId={expandedRowId}
                onToggleRow={(id) => setExpandedRowId((cur) => (id === null ? null : cur === id ? null : id))}
                onRemove={removeSongFromSession}
              />
            )}
            <p className="drag-hint">Mantené apretado y arrastrá para reordenar · deslizá a la izquierda para eliminar</p>

            <button className="session-add-row" onClick={() => setSessionAddMenuOpen(true)}>
              <div className="session-number session-number-ghost">{activeSessionSongs.length + 1}</div>
              <Plus size={17} />
              <span>Agregar canción</span>
            </button>

            {suggest?.error && <div className="form-error">{suggest.error}</div>}
            {suggest?.result && (
              <div className="suggest-card">
                <div className="suggest-card-head"><Sparkles size={15} /><span>Sugerencia</span></div>
                <div className="suggest-song-title">
                  {suggest.result.song.title}
                  {suggest.result.song.keys?.[0]?.tono ? <span className="session-tono"> | {suggest.result.song.keys[0].tono}</span> : null}
                </div>
                <div className="suggest-song-author">{suggest.result.song.author || "Autor desconocido"}</div>
                {suggest.result.reason && <p className="suggest-reason">{suggest.result.reason}</p>}
                <div className="suggest-actions">
                  <button className="btn btn-ghost" onClick={() => setSuggest(null)}>Descartar</button>
                  <button className="btn btn-ghost" onClick={runSuggest}><RefreshCw size={14} /> Otra</button>
                  <button className="btn btn-primary" onClick={() => addSongToActiveSession(suggest.result.song)}><Check size={14} /> Agregar</button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="sessions-view">
            {sessions.length === 0 ? (
              <EmptyState icon={<ListMusic size={28} />} title="Todavía no armaste sesiones" hint="Creá una sesión para preparar tu próximo show" />
            ) : (
              <div className="session-list">
                {sessions
                  .slice()
                  .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
                  .map((s) => (
                    <SwipeToDeleteRow
                      key={s.id}
                      id={s.id}
                      openId={openSwipeSessionId}
                      setOpenId={setOpenSwipeSessionId}
                      onDelete={() => deleteSession(s.id)}
                      onTap={() => setActiveSessionId(s.id)}
                    >
                      <div className="session-card">
                        <div className="session-card-icon"><ListMusic size={18} /></div>
                        <div className="session-card-body">
                          <div className="session-card-title">{s.title || formatDate(s.date)}</div>
                          <div className="session-card-sub">{formatDate(s.date)} · {s.songIds.length} canción{s.songIds.length !== 1 ? "es" : ""}</div>
                        </div>
                        <ChevronRight size={17} />
                      </div>
                    </SwipeToDeleteRow>
                  ))}
              </div>
            )}
            <button className="fab" onClick={() => createSession(null)} aria-label="Nueva sesión">
              <Plus size={24} />
            </button>
          </div>
        )}
      </main>

      <nav className="bottom-nav">
        <button className={tab === "songs" ? "nav-active" : ""} onClick={() => { setTab("songs"); setActiveSessionId(null); }}>
          <Music2 size={20} /><span>Canciones</span>
        </button>
        <button className={tab === "sessions" ? "nav-active" : ""} onClick={() => setTab("sessions")}>
          <ListMusic size={20} /><span>Sesiones</span>
        </button>
      </nav>

      {viewingSong && (
        <SongDetailSheet
          song={viewingSong}
          onClose={() => setViewingSong(null)}
          onEdit={(song) => {
            setViewingSong(null);
            setEditingSong(song);
            setFormOpen(true);
          }}
          onAddClick={(song) => {
            setViewingSong(null);
            setAddSheetSong(song);
          }}
        />
      )}

      {formOpen && (
        <SongForm initial={editingSong} onSave={saveSong} onDelete={deleteSong} onClose={() => { setFormOpen(false); setEditingSong(null); }} />
      )}

      {addSheetSong && (
        <AddToSessionSheet song={addSheetSong} sessions={sessions} onClose={() => setAddSheetSong(null)} onCreateNew={createSession} onAddToExisting={addSongToSession} />
      )}

      {sessionSearchOpen && activeSession && (
        <SearchSheet songs={songs} excludeIds={activeSession.songIds} onClose={() => setSessionSearchOpen(false)} onPick={addSongToActiveSession} />
      )}

      {sessionAddMenuOpen && activeSession && (
        <Sheet title="Agregar canción" onClose={() => setSessionAddMenuOpen(false)}>
          <button className="option-row" onClick={() => { setSessionAddMenuOpen(false); setSessionSearchOpen(true); }}>
            <div className="option-icon"><Search size={16} /></div>
            <div>
              <div className="option-title">Buscar canción</div>
              <div className="option-sub">Elegirla vos mismo del repertorio</div>
            </div>
            <ChevronRight size={16} className="option-chevron" />
          </button>
          {activeSessionSongs.length > 0 && (
            <button className="option-row" onClick={runSuggest}>
              <div className="option-icon"><Sparkles size={16} /></div>
              <div>
                <div className="option-title">Sugerir canción</div>
                <div className="option-sub">Basado en la letra del tema anterior</div>
              </div>
              <ChevronRight size={16} className="option-chevron" />
            </button>
          )}
        </Sheet>
      )}
    </div>
  );
}

/* ---------------- CSS ---------------- */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Lexend:wght@400;500;600;700&display=swap');
/* Bloqueo de zoom en inputs para iOS Safari */
input, select, textarea {
  font-size: 16px !important;
  touch-action: manipulation;
}

html, body {
  width: 100%;
  margin: 0;
  padding: 0;
  overflow-x: hidden;
}
:root {
  --bg: #ffffff;
  --bg-elev: #f2f2f4;
  --bg-elev-2: #e7e7ea;
  --line: #e2e2e5;
  --text: #111111;
  --text-dim: #4b4b4f;
  --text-faint: #79797d;
  --danger: #b3261e;
  --danger-dim: #fbeceb;
  --radius-sm: 7px;
  --radius-md: 12px;
  --radius-lg: 20px;
}

* { box-sizing: border-box; }

.app {
  font-family: 'Lexend', -apple-system, BlinkMacSystemFont, sans-serif;
  background: var(--bg);
  color: var(--text);
  min-height: 100vh;
  width: 100%;
  max-width: 480px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  position: relative;
  padding-bottom: 76px;
}

.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.app-header { padding: 22px 20px 16px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--line); }
.staff-lines { display: flex; flex-direction: column; gap: 3px; width: 22px; }
.staff-lines span { display: block; height: 1px; background: var(--text-faint); }
.staff-lines span:nth-child(1) { width: 22px; }
.staff-lines span:nth-child(2) { width: 14px; }
.staff-lines span:nth-child(3) { width: 18px; }
.wordmark { font-weight: 700; font-size: 22px; letter-spacing: 0.01em; margin: 0; color: var(--text); flex: 1; margin-left: 12px; }
.refresh-icon { color: var(--text-faint); }

.banner-error { margin: 10px 16px 0; background: var(--danger-dim); color: var(--danger); padding: 10px 14px; border-radius: var(--radius-sm); font-size: 13px; cursor: pointer; display: flex; justify-content: space-between; gap: 8px; }

.app-main { flex: 1; padding: 16px; }

.search-bar { display: flex; align-items: center; gap: 8px; background: var(--bg-elev); border: 1px solid var(--line); border-radius: var(--radius-md); padding: 10px 12px; color: var(--text-faint); }
.search-bar input { flex: 1; background: none; border: none; outline: none; color: var(--text); font-size: 16px; font-family: inherit; }
.search-bar input::placeholder { color: var(--text-faint); }

.filter-row {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  width: 100%;
}

.filter-row select {
  flex: 1;
  min-width: 0;
  background: var(--bg-elev);
  border: 1px solid var(--line);
  color: var(--text-dim);
  border-radius: var(--radius-sm);
  padding: 8px 6px;
  font-size: 16px !important;
  font-family: inherit;
  text-overflow: ellipsis;
  white-space: nowrap;
  overflow: hidden;
}

.btn { display: inline-flex; align-items: center; gap: 6px; justify-content: center; border: none; border-radius: var(--radius-sm); padding: 10px 14px; font-size: 14px; font-weight: 600; font-family: inherit; cursor: pointer; }
.btn:disabled { opacity: 0.5; cursor: default; }
.btn-primary { background: var(--bg-elev-2); color: var(--text); border: 1.5px solid var(--text); }
.btn-secondary { background: var(--bg-elev); color: var(--text); border: 1px solid var(--line); }
.btn-ghost { background: transparent; color: var(--text-dim); }
.btn-danger { background: var(--danger-dim); color: var(--danger); }

.link-btn { background: none; border: none; color: var(--text); text-decoration: underline; font-size: 13px; font-family: inherit; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; padding: 0; font-weight: 600; }

.icon-btn { background: none; border: none; color: var(--text-dim); cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 6px; border-radius: 8px; }
.icon-btn:hover { background: var(--bg-elev); }
.icon-btn.danger { color: var(--danger); }
.icon-btn.tiny { padding: 4px; }
.icon-btn:disabled { opacity: 0.3; cursor: default; }
.icon-btn:disabled:hover { background: none; }

.song-list { display: flex; flex-direction: column; gap: 8px; margin-top: 14px; }
.song-row { display: flex; align-items: stretch; gap: 4px; background: var(--bg-elev); border: 1px solid var(--line); border-radius: var(--radius-md); overflow: hidden; }
.song-row-main { flex: 1; text-align: left; background: none; border: none; padding: 12px 14px; cursor: pointer; font-family: inherit; color: var(--text); display: flex; flex-direction: column; gap: 4px; }
.song-row-top { display: flex; align-items: baseline; gap: 8px; }
.song-title { font-size: 16.5px; font-weight: 600; color: var(--text); }
.song-tono { color: var(--text); font-size: 14px; font-weight: 700; }
.song-row-bottom { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.song-author { color: var(--text-dim); font-size: 12.5px; }
.song-singer { color: var(--text-faint); font-size: 12.5px; }
.add-btn { margin: 8px 8px 8px 0; align-self: center; color: var(--text); }

.pill { font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight: 600; background: var(--bg-elev-2); color: var(--text-dim); }

.empty-state { display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; padding: 60px 20px; color: var(--text-faint); }
.empty-title { font-size: 16px; font-weight: 600; color: var(--text-dim); margin: 0; }
.empty-hint { font-size: 13px; margin: 0; }

.fab { position: fixed; bottom: 92px; right: calc(50% - 240px + 20px); width: 52px; height: 52px; border-radius: 50%; background: var(--bg-elev-2); color: var(--text); border: 1px solid var(--line); display: flex; align-items: center; justify-content: center; box-shadow: 0 6px 16px rgba(0,0,0,0.12); cursor: pointer; }
@media (max-width: 480px) { .fab { right: 20px; } }

.bottom-nav { position: fixed; bottom: 0; left: 50%; transform: translateX(-50%); width: 100%; max-width: 480px; background: var(--bg-elev); border-top: 1px solid var(--line); display: flex; padding: 8px 0 calc(8px + env(safe-area-inset-bottom)); }
.bottom-nav button { flex: 1; background: none; border: none; display: flex; flex-direction: column; align-items: center; gap: 3px; color: var(--text-faint); font-size: 11px; font-family: inherit; padding: 6px 0; cursor: pointer; }
.bottom-nav button.nav-active { color: var(--text); font-weight: 700; }

.sheet-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.35); display: flex; align-items: flex-end; justify-content: center; z-index: 50; }
.sheet { background: var(--bg); width: 100%; max-width: 480px; max-height: 88vh; border-radius: 20px 20px 0 0; display: flex; flex-direction: column; overflow: hidden; border-top: 1px solid var(--line); }
.sheet-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 18px; border-bottom: 1px solid var(--line); }
.sheet-header h2 { font-size: 18px; margin: 0; font-weight: 700; color: #111111; word-break: break-word; }
.sheet-body { padding: 16px 18px; overflow-y: auto; flex: 1; }
.sheet-footer { padding: 12px 18px; border-top: 1px solid var(--line); }
.sheet-divider { font-size: 12px; color: var(--text-faint); padding: 12px 2px 4px; }

.footer-row { display: flex; align-items: center; gap: 8px; }
.footer-spacer { flex: 1; }

.field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; font-size: 13px; color: var(--text-dim); }
.field input, .field textarea { background: var(--bg-elev); border: 1px solid var(--line); color: var(--text); border-radius: var(--radius-sm); padding: 10px 12px; font-size: 16px; font-family: inherit; resize: vertical; }
.field textarea { font-family: inherit; line-height: 1.5; }
.form-error { background: var(--danger-dim); color: var(--danger); padding: 8px 12px; border-radius: var(--radius-sm); font-size: 13px; margin-bottom: 12px; }

.keys-block { background: var(--bg-elev); border: 1px solid var(--line); border-radius: var(--radius-md); padding: 12px; margin-bottom: 14px; display: flex; flex-direction: column; gap: 12px; }
.key-row { display: flex; flex-direction: column; gap: 6px; }
.key-row-label { font-size: 12px; color: var(--text-faint); display: flex; justify-content: space-between; }
.key-row-fields { display: flex; gap: 8px; }
.key-tono { width: 72px; flex-shrink: 0; background: var(--bg); border: 1px solid var(--line); color: var(--text); border-radius: var(--radius-sm); padding: 8px 10px; font-family: inherit; font-size: 16px; }
.key-singer { flex: 1; background: var(--bg); border: 1px solid var(--line); color: var(--text); border-radius: var(--radius-sm); padding: 8px 10px; font-family: inherit; font-size: 16px; }
.add-key { margin-top: 2px; }

.segmented { display: flex; background: var(--bg-elev); border: 1px solid var(--line); border-radius: var(--radius-sm); overflow: hidden; }
.segmented button { flex: 1; background: none; border: none; padding: 9px; color: var(--text-dim); font-family: inherit; font-size: 13px; cursor: pointer; }
.segmented button.seg-active { background: var(--text); color: var(--bg); font-weight: 700; }

.sections-block { background: var(--bg-elev); border: 1px solid var(--line); border-radius: var(--radius-md); padding: 12px; display: flex; flex-direction: column; gap: 12px; }
.sections-empty { font-size: 13px; color: var(--text-faint); margin: 0; }
.section-item { background: var(--bg); border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.section-item-head { display: flex; align-items: center; justify-content: space-between; }
.section-item-label { font-size: 12.5px; font-weight: 700; color: var(--text); }
.section-item-controls { display: flex; gap: 2px; }
.section-item textarea { background: var(--bg-elev); font-size: 16px; }
.add-section-row { display: flex; gap: 8px; flex-wrap: wrap; }
.add-section-row .btn { flex: 1; min-width: 100px; }

.option-row { width: 100%; display: flex; align-items: center; gap: 12px; background: none; border: none; border-bottom: 1px solid var(--line); padding: 12px 4px; text-align: left; cursor: pointer; font-family: inherit; color: var(--text); }
.option-row:last-child { border-bottom: none; }
.option-icon { width: 32px; height: 32px; border-radius: 99px; background: var(--bg-elev); display: flex; align-items: center; justify-content: center; color: var(--text); flex-shrink: 0; }
.option-title { font-size: 14.5px; font-weight: 600; color: var(--text); }
.option-sub { font-size: 12.5px; color: var(--text-faint); margin-top: 2px; }
.option-chevron { margin-left: auto; color: var(--text-faint); flex-shrink: 0; }
.pick-list { display: flex; flex-direction: column; }

.swipe-track { position: relative; overflow: hidden; border-radius: var(--radius-md); }
.swipe-delete-bg { position: absolute; top: 0; right: 0; bottom: 0; width: 84px; background: var(--danger); color: #ffffff; border: none; display: flex; align-items: center; justify-content: center; cursor: pointer; }
.swipe-content { position: relative; will-change: transform; touch-action: pan-y; }

.session-list { display: flex; flex-direction: column; gap: 8px; }
.session-card { display: flex; align-items: center; gap: 12px; background: var(--bg-elev); border: 1px solid var(--line); border-radius: var(--radius-md); padding: 13px 14px; cursor: pointer; font-family: inherit; color: var(--text); text-align: left; }
.session-card-icon { width: 34px; height: 34px; border-radius: 10px; background: var(--bg-elev-2); color: var(--text); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.session-card-body { flex: 1; }
.session-card-title { font-size: 15.5px; font-weight: 700; color: var(--text); }
.session-card-sub { font-size: 12px; color: var(--text-faint); margin-top: 2px; }

.session-editor-header { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
.session-editor-titlebox { flex: 1; display: flex; flex-direction: column; gap: 4px; }
.session-title-display { background: none; border: none; font-size: 18px; font-weight: 700; color: var(--text); display: flex; align-items: center; gap: 6px; cursor: pointer; padding: 0; }
.session-title-input { background: var(--bg-elev); border: 1px solid var(--line); color: var(--text); border-radius: 8px; padding: 6px 10px; font-size: 16px; font-family: inherit; }
.session-date-input { background: none; border: none; color: var(--text-faint); font-size: 12px; font-family: inherit; padding: 0; width: fit-content; }

.session-song-list { display: flex; flex-direction: column; gap: 8px; position: relative; }
.session-row-wrap { touch-action: pan-y; user-select: none; -webkit-user-select: none; }
.drag-hint { text-align: center; font-size: 11.5px; color: var(--text-faint); margin: 10px 0 0; }
.session-row { background: var(--bg-elev); border: 1px solid var(--line); border-radius: var(--radius-md); overflow: hidden; }
.session-row-dragging { border-color: var(--text-faint); box-shadow: 0 12px 28px rgba(0,0,0,0.18); }
.session-row-head { display: flex; align-items: center; gap: 4px; }
.session-number { width: 26px; height: 26px; border-radius: 50%; background: var(--bg-elev-2); color: var(--text); display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; flex-shrink: 0; margin-left: 12px; }
.session-row-title-btn { flex: 1; background: none; border: none; display: flex; align-items: center; justify-content: space-between; padding: 13px 14px; cursor: pointer; color: var(--text); font-family: inherit; text-align: left; gap: 8px; }
.session-title-line { font-size: 16px; font-weight: 600; color: var(--text); }
.session-tono { color: var(--text); font-weight: 700; }
.session-author-line { font-size: 12.5px; color: var(--text-faint); margin-top: 2px; }
.session-row-body { padding: 0 14px 16px; border-top: 1px solid var(--line); }
.session-row-meta { display: flex; gap: 6px; flex-wrap: wrap; margin: 12px 0; align-items: center; }
.yt-link { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-dim); text-decoration: underline; }
.session-row-lyrics { max-height: 340px; overflow-y: auto; }
.lyrics-empty { font-size: 13.5px; color: var(--text-faint); margin: 0; }
.lyrics-section { margin-bottom: 14px; }
.lyrics-section:last-child { margin-bottom: 0; }
.lyrics-section-label { font-size: 12px; font-weight: 700; color: var(--text-dim); margin-bottom: 4px; }
.lyrics-section-content { white-space: pre-wrap; font-family: inherit; font-size: 14.5px; line-height: 1.7; color: var(--text); background: var(--bg-elev-2); border-radius: var(--radius-sm); padding: 12px 14px; margin: 0; }

.session-add-row { margin-top: 10px; width: 100%; display: flex; align-items: center; gap: 10px; background: var(--bg); border: 1.5px dashed var(--line); border-radius: var(--radius-md); padding: 12px 14px; cursor: pointer; font-family: inherit; color: var(--text-dim); font-size: 14px; font-weight: 600; }
.session-number-ghost { background: transparent; border: 1.5px dashed var(--line); color: var(--text-faint); margin-left: 0; }

.suggest-card { margin-top: 12px; background: var(--bg-elev); border: 1px solid var(--line); border-radius: var(--radius-md); padding: 14px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.suggest-card-head { display: flex; align-items: center; gap: 6px; color: var(--text-dim); font-size: 12px; font-weight: 700; width: 100%; }
.suggest-song-title { font-size: 16.5px; font-weight: 700; color: var(--text); width: 100%; }
.suggest-song-author { font-size: 12.5px; color: var(--text-dim); margin-top: 1px; width: 100%; }
.suggest-reason { font-size: 13px; color: var(--text-dim); margin: 8px 0 0; line-height: 1.5; width: 100%; }
.suggest-actions { display: flex; gap: 8px; margin-top: 12px; width: 100%; }
.suggest-actions .btn { flex: 1; }
`;
