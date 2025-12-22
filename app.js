/* global Papa */
const { jsPDF } = window.jspdf;

const els = {
  csvFile: document.getElementById("csvFile"),
  btnClear: document.getElementById("btnClear"),
  fileInfo: document.getElementById("fileInfo"),
  status: document.getElementById("status"),
  mappingArea: document.getElementById("mappingArea"),
  recipientsTable: document.getElementById("recipientsTable"),
  btnGenerate: document.getElementById("btnGenerate"),
  countInfo: document.getElementById("countInfo"),

  paperSize: document.getElementById("paperSize"),
  outputName: document.getElementById("outputName"),
  labelsPerPage: document.getElementById("labelsPerPage"),

  senderBox: document.getElementById("senderBox"),
  btnSaveSender: document.getElementById("btnSaveSender"),
  btnClearSender: document.getElementById("btnClearSender"),
  senderSavedHint: document.getElementById("senderSavedHint"),
};

let parsedRows = [];
let headers = [];
let mapping = {};
let recipients = [];

const SENDER_STORAGE_KEY = "ebay_label_sender_text_v1";

// Expected eBay-ish fields (editable via mapping)
const FIELD_DEFS = [
  { key: "to_name", label: "Ship To Name", candidates: ["Ship To Name", "ShipToName", "Recipient Name", "Name"] },
  { key: "to_phone", label: "Ship To Phone", candidates: ["Ship To Phone", "Phone", "Recipient Phone"] },
  { key: "to_addr1", label: "Ship To Address 1", candidates: ["Ship To Address 1", "Address 1", "Street 1"] },
  { key: "to_addr2", label: "Ship To Address 2", candidates: ["Ship To Address 2", "Address 2", "Street 2"] },
  { key: "to_city", label: "Ship To City", candidates: ["Ship To City", "City", "Town"] },
  { key: "to_state", label: "Ship To State", candidates: ["Ship To State", "State", "Province", "Region"] },
  { key: "to_zip", label: "Ship To Zip", candidates: ["Ship To Zip", "Zip", "Postal Code", "Postcode"] },
  { key: "to_country", label: "Ship To Country", candidates: ["Ship To Country", "Country"] },

  // Tax fields in your example CSV:
  // eBay Reference Value (e.g. "GB 365 6085 76") + Tax Status (e.g. "Code:Paid")
  { key: "tax_ref", label: "eBay Reference Value (tax)", candidates: ["eBay Reference Value", "EBay Reference Value", "Reference Value"] },
  { key: "tax_status", label: "Tax Status", candidates: ["Tax Status", "TaxStatus"] },
];

// Table uses one editable Tax line column, default built as: "<ref> <status>"
const TABLE_COLUMNS = [
  { key: "name", label: "Name" },
  { key: "phone", label: "Phone" },
  { key: "addr1", label: "Address 1" },
  { key: "addr2", label: "Address 2" },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
  { key: "zip", label: "Zip" },
  { key: "country", label: "Country" },
  { key: "taxLine", label: "Tax line" },
];

// ---------- Utilities ----------
function setStatus(msg) {
  els.status.textContent = msg;
}

function norm(s) {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\w ]/g, "");
}

function findHeader(headersList, candidates) {
  const hNorm = headersList.map(h => ({ raw: h, n: norm(h) }));
  for (const c of candidates) {
    const cn = norm(c);
    const exact = hNorm.find(h => h.n === cn);
    if (exact) return exact.raw;
  }
  for (const c of candidates) {
    const cn = norm(c);
    const contains = hNorm.find(h => h.n.includes(cn) || cn.includes(h.n));
    if (contains) return contains.raw;
  }
  return "";
}

function safeStr(v) {
  return String(v ?? "").trim();
}

function joinCityLine(city, state, zip) {
  const parts = [];
  const c = safeStr(city);
  const s = safeStr(state);
  const z = safeStr(zip);
  if (c) parts.push(c);
  if (s) parts.push(s);
  let first = parts.join(", ");
  if (first && z) return `${first} ${z}`.trim();
  if (!first && z) return z;
  return first;
}

function wrapLines(doc, lines, maxWidthMm) {
  const out = [];
  for (const line of lines) {
    const s = safeStr(line);
    if (!s) continue;
    const wrapped = doc.splitTextToSize(s, maxWidthMm);
    for (const w of wrapped) out.push(w);
  }
  return out;
}

// ---------- Sender (one textbox, saved) ----------
function loadSenderFromStorage() {
  try {
    const v = localStorage.getItem(SENDER_STORAGE_KEY);
    if (v) els.senderBox.value = v;
    els.senderSavedHint.textContent = v ? "Loaded saved sender." : "";
  } catch {
    // ignore
  }
}

function saveSenderToStorage() {
  const v = els.senderBox.value ?? "";
  try {
    localStorage.setItem(SENDER_STORAGE_KEY, v);
    els.senderSavedHint.textContent = "Saved.";
    setTimeout(() => { els.senderSavedHint.textContent = ""; }, 1200);
  } catch {
    els.senderSavedHint.textContent = "Save failed in this browser.";
  }
}

let senderSaveTimer = null;
function autoSaveSenderSoon() {
  if (senderSaveTimer) clearTimeout(senderSaveTimer);
  senderSaveTimer = setTimeout(saveSenderToStorage, 350);
}

function senderLinesFromBox() {
  return (els.senderBox.value || "")
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);
}

// ---------- Mapping UI ----------
function buildMappingUI() {
  els.mappingArea.innerHTML = "";
  for (const def of FIELD_DEFS) {
    const wrapper = document.createElement("label");
    wrapper.textContent = def.label;

    const sel = document.createElement("select");
    sel.dataset.key = def.key;

    const optBlank = document.createElement("option");
    optBlank.value = "";
    optBlank.textContent = "(not set)";
    sel.appendChild(optBlank);

    for (const h of headers) {
      const opt = document.createElement("option");
      opt.value = h;
      opt.textContent = h;
      sel.appendChild(opt);
    }

    const guessed = findHeader(headers, def.candidates);
    mapping[def.key] = mapping[def.key] || guessed;
    sel.value = mapping[def.key] || "";

    sel.addEventListener("change", () => {
      mapping[def.key] = sel.value;
      rebuildRecipientsAndTable();
    });

    wrapper.appendChild(sel);
    els.mappingArea.appendChild(wrapper);
  }
}

function requiredMappingOK() {
  const must = ["to_name", "to_addr1", "to_city"];
  return must.every(k => safeStr(mapping[k]));
}

// ---------- CSV to recipients ----------
function rowToRecipient(row) {
  const get = (k) => (mapping[k] ? safeStr(row[mapping[k]]) : "");
  const taxRef = get("tax_ref");
  const taxStatus = get("tax_status");
  const taxLine = [taxRef, taxStatus].filter(Boolean).join(" ").trim();

  return {
    name: get("to_name"),
    phone: get("to_phone"),
    addr1: get("to_addr1"),
    addr2: get("to_addr2"),
    city: get("to_city"),
    state: get("to_state"),
    zip: get("to_zip"),
    country: get("to_country"),
    taxLine,
  };
}

function rebuildRecipientsAndTable() {
  if (!parsedRows.length || !headers.length) return;

  if (!requiredMappingOK()) {
    setStatus("Fix column mapping (needs at least Name, Address 1, City).");
    els.btnGenerate.disabled = true;
    recipients = [];
    renderTable([]);
    return;
  }

  recipients = parsedRows
    .map(rowToRecipient)
    .filter(r => r.name && r.addr1 && r.city);

  renderTable(recipients);
  els.countInfo.textContent = recipients.length ? `${recipients.length} recipient(s)` : "";
  els.btnGenerate.disabled = recipients.length === 0;

  setStatus(recipients.length ? "CSV loaded." : "No valid rows found (needs Name, Address 1, City).");
}

// ---------- Table rendering ----------
function renderTable(data) {
  const thead = els.recipientsTable.querySelector("thead");
  const tbody = els.recipientsTable.querySelector("tbody");
  thead.innerHTML = "";
  tbody.innerHTML = "";

  const trh = document.createElement("tr");
  for (const col of TABLE_COLUMNS) {
    const th = document.createElement("th");
    th.textContent = col.label;
    trh.appendChild(th);
  }
  const thAction = document.createElement("th");
  thAction.textContent = "Action";
  trh.appendChild(thAction);
  thead.appendChild(trh);

  data.forEach((r, idx) => {
    const tr = document.createElement("tr");
    tr.dataset.index = String(idx);

    for (const col of TABLE_COLUMNS) {
      const td = document.createElement("td");
      const inp = document.createElement("input");
      inp.type = "text";
      inp.value = r[col.key] ?? "";
      inp.dataset.key = col.key;
      td.appendChild(inp);
      tr.appendChild(td);
    }

    const tdBtn = document.createElement("td");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "secondary";
    btn.textContent = "Remove";
    btn.addEventListener("click", () => {
      recipients.splice(idx, 1);
      renderTable(recipients);
      els.countInfo.textContent = recipients.length ? `${recipients.length} recipient(s)` : "";
      els.btnGenerate.disabled = recipients.length === 0;
    });
    tdBtn.appendChild(btn);
    tr.appendChild(tdBtn);

    tbody.appendChild(tr);
  });
}

function readRecipientsFromTable() {
  const tbody = els.recipientsTable.querySelector("tbody");
  const out = [];
  for (const tr of tbody.querySelectorAll("tr")) {
    const obj = {};
    for (const inp of tr.querySelectorAll("input")) {
      obj[inp.dataset.key] = safeStr(inp.value);
    }
    if (obj.name && obj.addr1 && obj.city) out.push(obj);
  }
  return out;
}

// ---------- PDF generation ----------
function recipientLines(r) {
  const lines = [];
  if (r.name) lines.push(r.name);
  if (r.addr1) lines.push(r.addr1);
  if (r.addr2) lines.push(r.addr2);

  const cityLine = joinCityLine(r.city, r.state, r.zip);
  if (cityLine) lines.push(cityLine);

  if (r.country) lines.push(r.country);

  // Tax line: show exactly like "GB 365 6085 76 Code:Paid" (or whatever user edits)
  if (r.taxLine) lines.push(r.taxLine);

  if (r.phone) lines.push(`Phone: ${r.phone}`);
  return lines;
}

function generatePdf(allRecipients, senderLines, paperSize, labelsPerPage, filename) {
  const doc = new jsPDF({ unit: "mm", format: paperSize });

  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();

  const margin = 20;
  const xFrom = margin;
  const xTo = pageW / 2;
  const shiftDownTo = 25;

  const topPad = 18;
  const usableH = pageH - topPad * 2;
  const step = usableH / Math.max(1, labelsPerPage);
  const yPositions = Array.from({ length: labelsPerPage }, (_, i) => topPad + i * step);

  const headerFont = 12;
  const textFont = 12;
  const lineH = 12 * 0.352778 * 1.2;

  const leftMaxW = (pageW / 2) - margin - 6;
  const rightMaxW = pageW - xTo - margin;

  let labelCounter = 0;

  for (let i = 0; i < allRecipients.length; i++) {
    const r = allRecipients[i];

    const yFrom = yPositions[labelCounter];
    const yTo = yFrom + shiftDownTo;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(headerFont);
    doc.text("Ship From:", xFrom, yFrom);
    doc.text("Ship To:", xTo, yTo);

    doc.setFontSize(textFont);

    const sWrapped = wrapLines(doc, senderLines, leftMaxW);
    doc.text(sWrapped, xFrom, yFrom + lineH);

    const rWrapped = wrapLines(doc, recipientLines(r), rightMaxW);
    doc.text(rWrapped, xTo, yTo + lineH);

    labelCounter++;

    if (labelCounter === labelsPerPage && i !== allRecipients.length - 1) {
      doc.addPage();
      labelCounter = 0;
    }
  }

  doc.save(filename || "shipping_labels.pdf");
}

// ---------- Events ----------
els.csvFile.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  els.fileInfo.textContent = `Selected: ${file.name}`;
  setStatus("Parsing CSV...");

  const text = await file.text();
  const res = Papa.parse(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => String(h ?? "").trim(),
  });

  parsedRows = (res.data || []).filter(row => Object.values(row).some(v => safeStr(v)));
  headers = res.meta?.fields || [];

  if (!headers.length) {
    setStatus("Could not detect CSV headers.");
    return;
  }

  mapping = {};
  buildMappingUI();
  rebuildRecipientsAndTable();
});

els.btnGenerate.addEventListener("click", () => {
  const senderLines = senderLinesFromBox();
  if (!senderLines.length) {
    setStatus("Sender box is empty.");
    return;
  }

  const rowsNow = readRecipientsFromTable();
  if (!rowsNow.length) {
    setStatus("No valid recipients.");
    return;
  }

  const paperSize = els.paperSize.value;
  const labelsPerPage = Math.max(1, Math.min(8, Number(els.labelsPerPage.value || 3)));
  const filename = safeStr(els.outputName.value) || "shipping_labels.pdf";

  try {
    setStatus("Generating PDF...");
    generatePdf(rowsNow, senderLines, paperSize, labelsPerPage, filename);
    setStatus("PDF generated.");
  } catch (err) {
    console.error(err);
    setStatus(`PDF generation failed: ${err?.message || err}`);
  }
});

els.btnClear.addEventListener("click", () => {
  els.csvFile.value = "";
  parsedRows = [];
  headers = [];
  mapping = {};
  recipients = [];
  els.mappingArea.innerHTML = "";
  els.fileInfo.textContent = "";
  els.countInfo.textContent = "";
  els.btnGenerate.disabled = true;
  renderTable([]);
  setStatus("Cleared.");
});

els.btnSaveSender.addEventListener("click", saveSenderToStorage);
els.btnClearSender.addEventListener("click", () => {
  els.senderBox.value = "";
  try { localStorage.removeItem(SENDER_STORAGE_KEY); } catch {}
  els.senderSavedHint.textContent = "";
  setStatus("Sender cleared.");
});

els.senderBox.addEventListener("input", autoSaveSenderSoon);

// init
renderTable([]);
loadSenderFromStorage();
setStatus("Upload CSV to start.");
