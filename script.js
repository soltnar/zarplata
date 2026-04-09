const advanceInput = document.getElementById("advanceFile");
const settlementInput = document.getElementById("settlementFile");
const deductionInput = document.getElementById("deductionFile");
const restaurantInput = document.getElementById("restaurantFile");

const processBtn = document.getElementById("processBtn");
const exportBtn = document.getElementById("exportBtn");
const applyFilterBtn = document.getElementById("applyFilterBtn");
const clearFilterBtn = document.getElementById("clearFilterBtn");

const restaurantFilter = document.getElementById("restaurantFilter");
const statusBox = document.getElementById("status");
const summaryBox = document.getElementById("summary");
const restaurantTotalsBox = document.getElementById("restaurantTotals");

const resultTbody = document.querySelector("#resultTable tbody");
const unassignedTbody = document.querySelector("#unassignedTable tbody");

let allRows = [];
let filteredRows = [];

const UNASSIGNED = "__UNASSIGNED__";

const NAME_HEADER_RE = /(фио|сотрудник|работник|фамил|получатель|employee|name|отчество)/i;
const SUM_HEADER_RE = /(сумм|к выдаче|квыплате|выплат|начисл|итог|итого|подсчет|аванс|выдан|на руки|amount|total|зачислить)/i;
const BONUS_RE = /(прем|bonus)/i;

const RESTAURANT_HEADER_RE = /(ресторан|подраздел|место работы|точка|объект|филиал|подразделение|restaurant)/i;
const DEDUCTION_HEADER_RE = /(удерж|взыск|штраф|вычет|алим|долг|deduct|debit)/i;

processBtn.addEventListener("click", async () => {
  try {
    clearUi();

    const advanceFile = advanceInput.files?.[0];
    const settlementFile = settlementInput.files?.[0];
    const deductionFile = deductionInput.files?.[0];
    const restaurantFile = restaurantInput.files?.[0];

    if (!advanceFile || !settlementFile) {
      setStatus("Выберите оба основных файла: Аванс и Подсчет.");
      return;
    }

    setStatus("Читаю файлы, объединяю выплаты, удержания и рестораны...");

    const tasks = [
      parseWorkbookEntries(advanceFile),
      parseWorkbookEntries(settlementFile),
      deductionFile ? parseDeductionEntries(deductionFile) : Promise.resolve([]),
      restaurantFile ? parseRestaurantMap(restaurantFile) : Promise.resolve(new Map()),
    ];

    const [advanceEntries, settlementEntries, deductionEntries, restaurantMap] = await Promise.all(tasks);

    allRows = buildResultRows({
      advanceEntries,
      settlementEntries,
      deductionEntries,
      restaurantMap,
    });

    populateRestaurantFilter(allRows);
    applyCurrentFilter();

    exportBtn.disabled = allRows.length === 0;

    if (!allRows.length) {
      setStatus("Данные не найдены. Проверьте, что в файлах есть колонки ФИО и суммы.");
      return;
    }

    const knownRestaurants = new Set(allRows.filter((r) => r.restaurant).map((r) => r.restaurant));
    const withoutRestaurant = allRows.filter((r) => !r.restaurant).length;

    let msg = `Готово. Сотрудников: ${allRows.length}. Ресторанов: ${knownRestaurants.size}.`;
    if (!restaurantFile) msg += " Файл ресторанов не загружен.";
    if (!deductionFile) msg += " Файл удержаний не загружен.";
    if (withoutRestaurant) msg += ` Без ресторана: ${withoutRestaurant}.`;

    setStatus(msg);
  } catch (error) {
    console.error(error);
    setStatus(`Ошибка обработки: ${error.message}`);
  }
});

applyFilterBtn.addEventListener("click", () => {
  applyCurrentFilter();
});

clearFilterBtn.addEventListener("click", () => {
  for (const option of restaurantFilter.options) option.selected = false;
  applyCurrentFilter();
});

exportBtn.addEventListener("click", () => {
  if (!filteredRows.length) return;

  const exportRows = filteredRows.map((item, idx) => ({
    "№": idx + 1,
    "Ресторан": item.restaurant || "Не определен",
    "ФИО": item.name,
    "Аванс (на руки)": item.advance,
    "Подсчет (на руки)": item.settlement,
    "Премия": item.bonus,
    "Удержания": item.deductions,
    "Итого на руки": item.totalNet,
    "ЗП с НДФЛ": item.totalGross,
    "НДФЛ аванса": item.advanceNdfl,
    "НДФЛ подсчета": item.settlementNdfl,
    "Общий НДФЛ": item.totalNdfl,
  }));

  const totalsByRestaurant = buildRestaurantTotals(filteredRows).map((x) => ({
    "Ресторан": x.restaurant,
    "Сотрудников": x.count,
    "Сумма удержаний": x.deductions,
  }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(exportRows), "Свод");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(totalsByRestaurant), "Удержания по ресторанам");
  XLSX.writeFile(wb, `Свод_ЗП_НДФЛ_Удержания_${todayStamp()}.xlsx`);
});

async function parseWorkbookEntries(file) {
  const wb = await readWorkbook(file);
  const entries = [];

  for (const sheetName of wb.SheetNames) {
    const rows = toRows(wb.Sheets[sheetName]);
    const header = detectSalaryHeader(rows);
    if (!header) continue;

    for (let i = header.headerRowIndex + 1; i < rows.length; i += 1) {
      const row = rows[i];
      const name = normalizeName(row?.[header.nameCol]);
      if (!name) continue;

      const amount = parseAmount(row?.[header.sumCol]);
      if (!Number.isFinite(amount) || amount === 0) continue;

      const rowText = row.map((v) => String(v ?? "")).join(" ").toLowerCase();
      const isBonus = BONUS_RE.test(sheetName.toLowerCase()) || BONUS_RE.test(rowText);

      entries.push({ name, amount, isBonus });
    }
  }

  return entries;
}

async function parseDeductionEntries(file) {
  const wb = await readWorkbook(file);
  const entries = [];

  for (const sheetName of wb.SheetNames) {
    const rows = toRows(wb.Sheets[sheetName]);
    const header = detectDeductionHeader(rows);
    if (!header) continue;

    for (let i = header.headerRowIndex + 1; i < rows.length; i += 1) {
      const row = rows[i];
      const name = normalizeName(row?.[header.nameCol]);
      if (!name) continue;

      const amount = parseAmount(row?.[header.sumCol]);
      if (!Number.isFinite(amount) || amount === 0) continue;

      if (header.kindCol >= 0) {
        const kindText = String(row?.[header.kindCol] ?? "").toLowerCase();
        if (kindText && !DEDUCTION_HEADER_RE.test(kindText)) continue;
      }

      entries.push({ name, amount });
    }
  }

  return entries;
}

async function parseRestaurantMap(file) {
  const wb = await readWorkbook(file);
  const map = new Map();

  for (const sheetName of wb.SheetNames) {
    const rows = toRows(wb.Sheets[sheetName]);
    const header = detectRestaurantHeader(rows);
    if (!header) continue;

    for (let i = header.headerRowIndex + 1; i < rows.length; i += 1) {
      const row = rows[i];
      const name = normalizeName(row?.[header.nameCol]);
      if (!name) continue;

      const restaurant = normalizeRestaurant(row?.[header.restaurantCol]);
      if (!restaurant) continue;

      map.set(name, restaurant);
    }
  }

  return map;
}

function buildResultRows({ advanceEntries, settlementEntries, deductionEntries, restaurantMap }) {
  const map = new Map();

  const ensure = (name) => {
    if (!map.has(name)) {
      map.set(name, {
        name,
        restaurant: restaurantMap.get(name) || "",
        advance: 0,
        settlement: 0,
        bonus: 0,
        deductions: 0,
      });
    }
    return map.get(name);
  };

  advanceEntries.forEach((e) => {
    const row = ensure(e.name);
    row.advance += e.amount;
    if (e.isBonus) row.bonus += e.amount;
  });

  settlementEntries.forEach((e) => {
    const row = ensure(e.name);
    row.settlement += e.amount;
    if (e.isBonus) row.bonus += e.amount;
  });

  deductionEntries.forEach((e) => {
    const row = ensure(e.name);
    row.deductions += e.amount;
  });

  const rows = Array.from(map.values()).map((item) => {
    const totalNet = item.advance + item.settlement;
    const totalGross = totalNet / 0.87;
    const advanceNdfl = item.advance / 0.87 - item.advance;
    const settlementNdfl = item.settlement / 0.87 - item.settlement;
    const totalNdfl = totalGross - totalNet;

    return {
      ...item,
      totalNet,
      totalGross,
      advanceNdfl,
      settlementNdfl,
      totalNdfl,
    };
  });

  rows.sort((a, b) => compareByRestaurantAndName(a, b));
  return rows;
}

function applyCurrentFilter() {
  const selected = new Set(Array.from(restaurantFilter.selectedOptions).map((o) => o.value));

  filteredRows = allRows.filter((row) => {
    if (selected.size === 0) return true;
    if (!row.restaurant) return selected.has(UNASSIGNED);
    return selected.has(row.restaurant);
  });

  renderFilteredRows(filteredRows);
  renderSummary(filteredRows);
  renderRestaurantTotals(filteredRows);

  exportBtn.disabled = filteredRows.length === 0;
}

function renderFilteredRows(rows) {
  const assigned = rows.filter((r) => r.restaurant);
  const unassigned = rows.filter((r) => !r.restaurant);

  resultTbody.innerHTML = "";
  unassignedTbody.innerHTML = "";

  assigned.forEach((row, idx) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td>${escapeHtml(row.restaurant)}</td>
      <td>${escapeHtml(row.name)}</td>
      <td>${fmt(row.advance)}</td>
      <td>${fmt(row.settlement)}</td>
      <td>${fmt(row.bonus)}</td>
      <td>${fmt(row.deductions)}</td>
      <td>${fmt(row.totalNet)}</td>
      <td>${fmt(row.totalGross)}</td>
      <td>${fmt(row.advanceNdfl)}</td>
      <td>${fmt(row.settlementNdfl)}</td>
      <td>${fmt(row.totalNdfl)}</td>
    `;
    resultTbody.appendChild(tr);
  });

  unassigned.forEach((row, idx) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td>${escapeHtml(row.name)}</td>
      <td>${fmt(row.deductions)}</td>
      <td>${fmt(row.advance)}</td>
      <td>${fmt(row.settlement)}</td>
      <td>${fmt(row.bonus)}</td>
      <td>${fmt(row.totalNet)}</td>
      <td>${fmt(row.totalGross)}</td>
      <td>${fmt(row.totalNdfl)}</td>
    `;
    unassignedTbody.appendChild(tr);
  });
}

function renderSummary(rows) {
  if (!rows.length) {
    summaryBox.innerHTML = "";
    return;
  }

  const totals = rows.reduce(
    (acc, row) => {
      acc.advance += row.advance;
      acc.settlement += row.settlement;
      acc.bonus += row.bonus;
      acc.deductions += row.deductions;
      acc.totalNet += row.totalNet;
      acc.totalGross += row.totalGross;
      acc.advanceNdfl += row.advanceNdfl;
      acc.settlementNdfl += row.settlementNdfl;
      acc.totalNdfl += row.totalNdfl;
      return acc;
    },
    {
      advance: 0,
      settlement: 0,
      bonus: 0,
      deductions: 0,
      totalNet: 0,
      totalGross: 0,
      advanceNdfl: 0,
      settlementNdfl: 0,
      totalNdfl: 0,
    }
  );

  const withRestaurant = rows.filter((r) => r.restaurant).length;
  const withoutRestaurant = rows.length - withRestaurant;

  summaryBox.innerHTML = [
    rowStat("Сотрудников (фильтр)", String(rows.length)),
    rowStat("Сотрудников с рестораном", String(withRestaurant)),
    rowStat("Сотрудников без ресторана", String(withoutRestaurant)),
    rowStat("Общий аванс (на руки)", fmt(totals.advance)),
    rowStat("Общий подсчет (на руки)", fmt(totals.settlement)),
    rowStat("Общая премия", fmt(totals.bonus)),
    rowStat("Общие удержания", fmt(totals.deductions)),
    rowStat("Итого на руки", fmt(totals.totalNet)),
    rowStat("ЗП с НДФЛ", fmt(totals.totalGross)),
    rowStat("НДФЛ аванса", fmt(totals.advanceNdfl)),
    rowStat("НДФЛ подсчета", fmt(totals.settlementNdfl)),
    rowStat("Общий НДФЛ", fmt(totals.totalNdfl)),
  ].join("");
}

function buildRestaurantTotals(rows) {
  const map = new Map();

  rows.filter((r) => r.restaurant).forEach((row) => {
    const cur = map.get(row.restaurant) || { restaurant: row.restaurant, count: 0, deductions: 0 };
    cur.count += 1;
    cur.deductions += row.deductions;
    map.set(row.restaurant, cur);
  });

  return Array.from(map.values()).sort((a, b) => a.restaurant.localeCompare(b.restaurant, "ru"));
}

function renderRestaurantTotals(rows) {
  const totals = buildRestaurantTotals(rows);

  if (!totals.length) {
    restaurantTotalsBox.innerHTML = rowStat("Удержания по ресторанам", "Нет данных для отображения");
    return;
  }

  const html = ["<h2>Сумма удержаний по ресторанам</h2>"];
  totals.forEach((item) => {
    html.push(
      rowStat(
        `${item.restaurant} (сотр.: ${item.count})`,
        fmt(item.deductions)
      )
    );
  });

  restaurantTotalsBox.innerHTML = html.join("");
}

function populateRestaurantFilter(rows) {
  restaurantFilter.innerHTML = "";

  const restaurants = Array.from(new Set(rows.filter((r) => r.restaurant).map((r) => r.restaurant))).sort((a, b) =>
    a.localeCompare(b, "ru")
  );

  restaurants.forEach((name) => {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    restaurantFilter.appendChild(option);
  });

  const unknownOption = document.createElement("option");
  unknownOption.value = UNASSIGNED;
  unknownOption.textContent = "Не определен ресторан";
  restaurantFilter.appendChild(unknownOption);

  applyFilterBtn.disabled = rows.length === 0;
  clearFilterBtn.disabled = rows.length === 0;
}

function detectSalaryHeader(rows) {
  return detectHeader(rows, {
    name: NAME_HEADER_RE,
    sum: SUM_HEADER_RE,
  });
}

function detectDeductionHeader(rows) {
  for (let r = 0; r < Math.min(rows.length, 80); r += 1) {
    const normalized = (rows[r] || []).map((cell) => String(cell ?? "").trim().toLowerCase());

    let nameCol = -1;
    let sumCol = -1;
    let kindCol = -1;

    for (let c = 0; c < normalized.length; c += 1) {
      const cell = normalized[c];
      if (nameCol === -1 && NAME_HEADER_RE.test(cell)) nameCol = c;
      if (sumCol === -1 && SUM_HEADER_RE.test(cell)) sumCol = c;
      if (kindCol === -1 && DEDUCTION_HEADER_RE.test(cell)) kindCol = c;
      if (kindCol === -1 && /(название|операция|тип)/i.test(cell)) kindCol = c;
    }

    if (nameCol !== -1 && sumCol !== -1) {
      return { headerRowIndex: r, nameCol, sumCol, kindCol };
    }
  }

  return null;
}

function detectRestaurantHeader(rows) {
  return detectHeader(rows, {
    name: NAME_HEADER_RE,
    restaurant: RESTAURANT_HEADER_RE,
  });
}

function detectHeader(rows, patternMap) {
  const keys = Object.keys(patternMap);

  for (let r = 0; r < Math.min(rows.length, 80); r += 1) {
    const normalized = (rows[r] || []).map((cell) => String(cell ?? "").trim().toLowerCase());
    const positions = {};

    keys.forEach((k) => {
      positions[k] = -1;
    });

    for (let c = 0; c < normalized.length; c += 1) {
      const cell = normalized[c];
      keys.forEach((k) => {
        if (positions[k] === -1 && patternMap[k].test(cell)) positions[k] = c;
      });
    }

    if (keys.every((k) => positions[k] !== -1)) {
      return {
        headerRowIndex: r,
        ...Object.fromEntries(keys.map((k) => [`${k}Col`, positions[k]])),
      };
    }
  }

  return null;
}

async function readWorkbook(file) {
  const buffer = await file.arrayBuffer();
  return XLSX.read(buffer, {
    type: "array",
    cellDates: false,
    cellFormula: false,
    raw: true,
  });
}

function toRows(worksheet) {
  return XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    raw: false,
    blankrows: false,
    defval: "",
  });
}

function compareByRestaurantAndName(a, b) {
  const ra = a.restaurant || "яяя__без_ресторана";
  const rb = b.restaurant || "яяя__без_ресторана";
  const byRestaurant = ra.localeCompare(rb, "ru");
  if (byRestaurant !== 0) return byRestaurant;
  return a.name.localeCompare(b.name, "ru");
}

function parseAmount(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const raw = String(value ?? "").trim();
  if (!raw) return NaN;

  const cleaned = raw
    .replace(/\s+/g, "")
    .replace(/[^\d,.-]/g, "")
    .replace(/,(?=\d{1,2}$)/, ".")
    .replace(/,/g, "");

  const num = Number(cleaned);
  return Number.isFinite(num) ? num : NaN;
}

function normalizeName(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (/^(итого|всего|подпис|дата|номер|лист|по лицевому счету)$/i.test(raw)) return "";

  return raw
    .replace(/\s+/g, " ")
    .replace(/["'`]+/g, "")
    .trim();
}

function normalizeRestaurant(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (/^(итого|всего|подпис|дата|номер|лист)$/i.test(raw)) return "";
  return raw.replace(/\s+/g, " ").trim();
}

function fmt(value) {
  return Number(value || 0).toLocaleString("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function rowStat(label, value) {
  return `<div class="summary-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function setStatus(text) {
  statusBox.textContent = text;
}

function clearUi() {
  setStatus("");
  summaryBox.innerHTML = "";
  restaurantTotalsBox.innerHTML = "";
  resultTbody.innerHTML = "";
  unassignedTbody.innerHTML = "";

  restaurantFilter.innerHTML = "";
  applyFilterBtn.disabled = true;
  clearFilterBtn.disabled = true;
  exportBtn.disabled = true;

  allRows = [];
  filteredRows = [];
}

function todayStamp() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
