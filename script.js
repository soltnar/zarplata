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
const filterPanel = document.getElementById("filterPanel");
const summaryPanel = document.getElementById("summaryPanel");
const restaurantTotalsPanel = document.getElementById("restaurantTotalsPanel");
const resultTablePanel = document.getElementById("resultTablePanel");
const unassignedPanel = document.getElementById("unassignedPanel");
const modeChip = document.getElementById("modeChip");
const versionChip = document.getElementById("versionChip");

const APP_VERSION = "2026.04.10.02";

const resultTbody = document.querySelector("#resultTable tbody");
const unassignedTbody = document.querySelector("#unassignedTable tbody");

let allRows = [];
let filteredRows = [];
let currentMode = { payroll: false, deductions: false };
let baseStatusMessage = "";

const UNASSIGNED = "__UNASSIGNED__";

const NAME_HEADER_RE = /(фио|сотрудник|работник|фамил|получатель|employee|name|отчество)/i;
const SUM_HEADER_RE = /(сумм|к выдаче|квыплате|выплат|начисл|итог|итого|подсчет|аванс|выдан|на руки|amount|total)/i;
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

    const payrollMode = Boolean(advanceFile && settlementFile);
    const deductionsMode = Boolean(deductionFile && restaurantFile);

    if (!payrollMode && !deductionsMode) {
      setStatus("Загрузите либо пару файлов Аванс+Подсчет, либо пару Удержания+Сотрудники/рестораны.");
      return;
    }

    currentMode = { payroll: payrollMode, deductions: deductionsMode };
    applyLayoutMode();
    baseStatusMessage = "Читаю файлы и формирую результат...";
    setStatus(baseStatusMessage);

    const tasks = [
      payrollMode ? parseWorkbookEntries(advanceFile) : Promise.resolve([]),
      payrollMode ? parseWorkbookEntries(settlementFile) : Promise.resolve([]),
      deductionFile ? parseDeductionEntries(deductionFile) : Promise.resolve([]),
      restaurantFile
        ? parseRestaurantMap(restaurantFile)
        : Promise.resolve({ map: new Map(), rows: [] }),
    ];

    const [advanceEntries, settlementEntries, deductionEntries, restaurantData] = await Promise.all(tasks);

    allRows = buildResultRows({
      advanceEntries,
      settlementEntries,
      deductionEntries,
      restaurantMap: restaurantData.map,
      restaurantRows: restaurantData.rows,
      includeAllEmployeesFromRestaurantList: deductionsMode && !payrollMode,
    });

    populateRestaurantFilter(allRows);
    applyCurrentFilter();

    exportBtn.disabled = allRows.length === 0;

    if (!allRows.length) {
      setStatus("Данные не найдены. Проверьте, что в файлах есть колонки ФИО и суммы.");
      return;
    }

    const visibleRows = allRows.filter(shouldDisplayRowByMode);
    const knownRestaurants = new Set(visibleRows.filter((r) => r.restaurant).map((r) => r.restaurant));
    const withoutRestaurant = visibleRows.filter((r) => !r.restaurant).length;

    let msg = `Готово. Сотрудников: ${visibleRows.length}. Ресторанов: ${knownRestaurants.size}.`;
    if (payrollMode && !deductionsMode) msg += " Рассчитан блок НДФЛ.";
    if (deductionsMode && !payrollMode) msg += " Рассчитан блок удержаний.";
    if (payrollMode && deductionsMode) msg += " Рассчитаны оба блока.";
    if (payrollMode && !restaurantFile) msg += " Файл ресторанов не загружен.";
    if (payrollMode && !deductionFile) msg += " Файл удержаний не загружен.";
    if (withoutRestaurant) msg += ` Без ресторана: ${withoutRestaurant}.`;

    baseStatusMessage = msg;
    setStatus(buildStatusMessage(msg));
  } catch (error) {
    console.error(error);
    baseStatusMessage = "";
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

  const payrollOnly = currentMode.payroll && !currentMode.deductions;
  const deductionsOnly = !currentMode.payroll && currentMode.deductions;
  const hasRestaurant = filteredRows.some((r) => Boolean(r.restaurant));
  const hasPremium = filteredRows.some((r) => Math.abs(r.bonus) > 0.000001);

  const exportRows = filteredRows.map((item, idx) => {
    const row = {
      "№": idx + 1,
      "ФИО": item.name,
    };

    if (hasRestaurant) row["Ресторан"] = item.restaurant || "Не определен";

    if (deductionsOnly) {
      row["Удержания"] = item.deductions;
      return row;
    }

    row["Аванс (на руки)"] = item.advance;
    row["Подсчет (на руки)"] = item.settlement;
    if (hasPremium) row["Премия"] = item.bonus;
    if (!payrollOnly) row["Удержания"] = item.deductions;
    row["Итого на руки"] = item.totalNet;
    row["ЗП с НДФЛ"] = item.totalGross;
    row["НДФЛ аванса"] = item.advanceNdfl;
    row["НДФЛ подсчета"] = item.settlementNdfl;
    row["Общий НДФЛ"] = item.totalNdfl;
    return row;
  });

  const totalsByRestaurant = currentMode.deductions
    ? buildRestaurantTotals(filteredRows).map((x) => ({
        "Ресторан": x.restaurant,
        "Сотрудников": x.count,
        "Сумма удержаний": x.deductions,
      }))
    : [];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(exportRows), "Свод");
  if (totalsByRestaurant.length > 0) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(totalsByRestaurant), "Удержания по ресторанам");
  }

  const modeSuffix = payrollOnly ? "ЗП_НДФЛ" : deductionsOnly ? "Удержания" : "ЗП_НДФЛ_Удержания";
  XLSX.writeFile(wb, `Свод_${modeSuffix}_${todayStamp()}_v${APP_VERSION}.xlsx`);
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

    const useDeductionCol = shouldUseDeductionColumn(rows, header);

    for (let i = header.headerRowIndex + 1; i < rows.length; i += 1) {
      const row = rows[i];
      const name = normalizeName(row?.[header.nameCol]);
      if (!name) continue;

      const amountRaw =
        useDeductionCol && header.deductionAmountCol >= 0
          ? row?.[header.deductionAmountCol]
          : row?.[header.sumCol];
      const amount = parseAmount(amountRaw);
      if (!Number.isFinite(amount) || amount === 0) continue;

      entries.push({ name, amount });
    }
  }

  return entries;
}

function shouldUseDeductionColumn(rows, header) {
  if (header.deductionAmountCol < 0) return false;

  let nonZero = 0;
  for (let i = header.headerRowIndex + 1; i < rows.length; i += 1) {
    const row = rows[i];
    const name = normalizeName(row?.[header.nameCol]);
    if (!name) continue;

    const value = parseAmount(row?.[header.deductionAmountCol]);
    if (Number.isFinite(value) && value !== 0) {
      nonZero += 1;
      if (nonZero >= 3) return true;
    }
  }

  return false;
}

async function parseRestaurantMap(file) {
  const wb = await readWorkbook(file);
  const map = new Map();
  const rowsOut = [];

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
      rowsOut.push({ name, restaurant });
    }
  }

  return { map, rows: rowsOut };
}

function buildResultRows({
  advanceEntries,
  settlementEntries,
  deductionEntries,
  restaurantMap,
  restaurantRows,
  includeAllEmployeesFromRestaurantList,
}) {
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

  if (includeAllEmployeesFromRestaurantList) {
    restaurantRows.forEach((employee) => {
      ensure(employee.name);
    });
  }

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
  const payrollOnly = currentMode.payroll && !currentMode.deductions;
  const selected = new Set(Array.from(restaurantFilter.selectedOptions).map((o) => o.value));

  const selectedRows = payrollOnly
    ? [...allRows]
    : allRows.filter((row) => {
        if (selected.size === 0) return true;
        if (!row.restaurant) return selected.has(UNASSIGNED);
        return selected.has(row.restaurant);
      });

  filteredRows = selectedRows.filter(shouldDisplayRowByMode);

  applyPremiumVisibility(filteredRows);

  renderFilteredRows(filteredRows);
  renderSummary(filteredRows);
  renderRestaurantTotals(filteredRows);

  exportBtn.disabled = filteredRows.length === 0;
  if (baseStatusMessage) setStatus(buildStatusMessage(baseStatusMessage));
}

function renderFilteredRows(rows) {
  const payrollOnly = currentMode.payroll && !currentMode.deductions;
  const deductionsOnly = !currentMode.payroll && currentMode.deductions;
  const assigned = payrollOnly ? rows : rows.filter((r) => r.restaurant);
  const unassigned = payrollOnly ? [] : rows.filter((r) => !r.restaurant);

  resultTbody.innerHTML = "";
  unassignedTbody.innerHTML = "";

  if (assigned.length === 0) {
    const noDataCols = payrollOnly ? 10 : deductionsOnly ? 4 : 12;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan=\"${noDataCols}\">Нет данных для отображения</td>`;
    resultTbody.appendChild(tr);
  }

  assigned.forEach((row, idx) => {
    const tr = document.createElement("tr");
    if (payrollOnly) {
      tr.innerHTML = `
        <td>${idx + 1}</td>
        <td>${escapeHtml(row.name)}</td>
        <td>${fmt(row.advance)}</td>
        <td>${fmt(row.settlement)}</td>
        <td class="premium-col">${fmt(row.bonus)}</td>
        <td>${fmt(row.totalNet)}</td>
        <td>${fmt(row.totalGross)}</td>
        <td>${fmt(row.advanceNdfl)}</td>
        <td>${fmt(row.settlementNdfl)}</td>
        <td>${fmt(row.totalNdfl)}</td>
      `;
    } else if (deductionsOnly) {
      tr.innerHTML = `
        <td>${idx + 1}</td>
        <td>${escapeHtml(row.restaurant)}</td>
        <td>${escapeHtml(row.name)}</td>
        <td>${fmt(row.deductions)}</td>
      `;
    } else {
      tr.innerHTML = `
        <td>${idx + 1}</td>
        <td class="restaurant-col">${escapeHtml(row.restaurant)}</td>
        <td>${escapeHtml(row.name)}</td>
        <td class="payroll-col">${fmt(row.advance)}</td>
        <td class="payroll-col">${fmt(row.settlement)}</td>
        <td class="payroll-col premium-col">${fmt(row.bonus)}</td>
        <td class="deduction-col">${fmt(row.deductions)}</td>
        <td class="payroll-col">${fmt(row.totalNet)}</td>
        <td class="payroll-col">${fmt(row.totalGross)}</td>
        <td class="payroll-col">${fmt(row.advanceNdfl)}</td>
        <td class="payroll-col">${fmt(row.settlementNdfl)}</td>
        <td class="payroll-col">${fmt(row.totalNdfl)}</td>
      `;
    }
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
      <td class="premium-col">${fmt(row.bonus)}</td>
      <td>${fmt(row.totalNet)}</td>
      <td>${fmt(row.totalGross)}</td>
      <td>${fmt(row.totalNdfl)}</td>
    `;
    unassignedTbody.appendChild(tr);
  });

  toggleCollapsed(resultTablePanel, assigned.length === 0);
  toggleCollapsed(unassignedPanel, payrollOnly || unassigned.length === 0);
}

function renderSummary(rows) {
  if (!rows.length) {
    summaryBox.innerHTML = "";
    toggleCollapsed(summaryPanel, true);
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

  const lines = [
    rowStat("Сотрудников (фильтр)", String(rows.length)),
    rowStat("Сотрудников с рестораном", String(withRestaurant)),
    rowStat("Сотрудников без ресторана", String(withoutRestaurant)),
  ];

  if (currentMode.payroll) {
    lines.push(rowStat("Общий аванс (на руки)", fmt(totals.advance)));
    lines.push(rowStat("Общий подсчет (на руки)", fmt(totals.settlement)));
    if (Math.abs(totals.bonus) > 0.000001) {
      lines.push(rowStat("Общая премия", fmt(totals.bonus)));
    }
    lines.push(rowStat("Итого на руки", fmt(totals.totalNet)));
    lines.push(rowStat("ЗП с НДФЛ", fmt(totals.totalGross)));
    lines.push(rowStat("НДФЛ аванса", fmt(totals.advanceNdfl)));
    lines.push(rowStat("НДФЛ подсчета", fmt(totals.settlementNdfl)));
    lines.push(rowStat("Общий НДФЛ", fmt(totals.totalNdfl)));
  }

  if (currentMode.deductions) {
    lines.push(rowStat("Общие удержания", fmt(totals.deductions)));
  }

  summaryBox.innerHTML = lines.join("");
  toggleCollapsed(summaryPanel, false);
}

function buildRestaurantTotals(rows) {
  const map = new Map();

  const rowsForTotals = rows.filter((r) => r.restaurant);

  rowsForTotals.forEach((row) => {
    const cur = map.get(row.restaurant) || { restaurant: row.restaurant, count: 0, deductions: 0 };
    cur.count += 1;
    cur.deductions += row.deductions;
    map.set(row.restaurant, cur);
  });

  return Array.from(map.values())
    .filter((x) => x.deductions > 0 || currentMode.payroll)
    .sort((a, b) => a.restaurant.localeCompare(b.restaurant, "ru"));
}

function renderRestaurantTotals(rows) {
  const totals = buildRestaurantTotals(rows);

  if (!totals.length) {
    restaurantTotalsBox.innerHTML = "";
    toggleCollapsed(restaurantTotalsPanel, true);
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
  toggleCollapsed(restaurantTotalsPanel, false);
}

function populateRestaurantFilter(rows) {
  restaurantFilter.innerHTML = "";

  const visibleRows = rows.filter(shouldDisplayRowByMode);
  const restaurants = Array.from(new Set(visibleRows.filter((r) => r.restaurant).map((r) => r.restaurant))).sort((a, b) =>
    a.localeCompare(b, "ru")
  );

  restaurants.forEach((name) => {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    restaurantFilter.appendChild(option);
  });

  const hasUnassigned = visibleRows.some((r) => !r.restaurant);
  if (hasUnassigned) {
    const unknownOption = document.createElement("option");
    unknownOption.value = UNASSIGNED;
    unknownOption.textContent = "Не определен ресторан";
    restaurantFilter.appendChild(unknownOption);
  }

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
    let deductionAmountCol = -1;

    for (let c = 0; c < normalized.length; c += 1) {
      const cell = normalized[c];
      if (nameCol === -1 && NAME_HEADER_RE.test(cell)) nameCol = c;
      if (sumCol === -1 && SUM_HEADER_RE.test(cell)) sumCol = c;
      if (deductionAmountCol === -1 && /(взыскано|удерж|штраф|алим|вычет|deduct)/i.test(cell)) {
        deductionAmountCol = c;
      }
    }

    if (nameCol !== -1 && sumCol !== -1) {
      return { headerRowIndex: r, nameCol, sumCol, deductionAmountCol };
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
  if (/^\d+([.,]\d+)?$/.test(raw)) return "";
  if (/^[№#\d\s./-]+$/.test(raw)) return "";

  const cleaned = raw
    .replace(/\s+/g, " ")
    .replace(/["'`]+/g, "")
    .trim();

  if (!/[A-Za-zА-Яа-яЁё]/.test(cleaned)) return "";
  const fullNameLike = /^[A-Za-zА-Яа-яЁё-]{2,}(?:\s+[A-Za-zА-Яа-яЁё-]{2,}){1,5}$/.test(cleaned);
  const initialsLike = /^[A-Za-zА-Яа-яЁё-]{2,}\s+[A-Za-zА-Яа-яЁё]\.?\s+[A-Za-zА-Яа-яЁё]\.?$/.test(cleaned);
  if (!fullNameLike && !initialsLike) return "";
  return cleaned;
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

function buildStatusMessage(base) {
  if (!base) return "";
  if (!allRows.length) return base;

  const selected = Array.from(restaurantFilter.selectedOptions).map((o) => o.value);
  if (!selected.length) {
    return `${base} Фильтр: все рестораны. Показано: ${filteredRows.length}.`;
  }

  const labels = selected.map((value) => (value === UNASSIGNED ? "Без ресторана" : value));
  const preview = labels.slice(0, 2).join(", ");
  const suffix = labels.length > 2 ? ` и еще ${labels.length - 2}` : "";
  return `${base} Фильтр: ${preview}${suffix}. Показано: ${filteredRows.length}.`;
}

function applyPremiumVisibility(rows) {
  const hasPremium = currentMode.payroll && rows.some((r) => Math.abs(r.bonus) > 0.000001);
  document.body.classList.toggle("hide-premium", !hasPremium);
}

function shouldDisplayRowByMode(row) {
  if (currentMode.deductions && !currentMode.payroll) {
    return row.deductions > 0;
  }
  return true;
}

function applyLayoutMode() {
  document.body.classList.remove("mode-payroll-only", "mode-deductions-only", "mode-combined", "mode-idle");

  const idle = !currentMode.payroll && !currentMode.deductions;
  const payrollOnly = currentMode.payroll && !currentMode.deductions;
  const deductionsOnly = !currentMode.payroll && currentMode.deductions;

  if (idle) {
    document.body.classList.add("mode-idle");
    if (modeChip) modeChip.textContent = "Режим: ожидание файлов";
    toggleCollapsed(filterPanel, true);
    toggleCollapsed(restaurantTotalsPanel, true);
    toggleCollapsed(unassignedPanel, true);
    toggleCollapsed(summaryPanel, true);
    toggleCollapsed(resultTablePanel, true);
    return;
  }

  if (payrollOnly) {
    document.body.classList.add("mode-payroll-only");
    if (modeChip) modeChip.textContent = "Режим: только НДФЛ";
    toggleCollapsed(filterPanel, true);
    toggleCollapsed(restaurantTotalsPanel, true);
    toggleCollapsed(unassignedPanel, true);
    toggleCollapsed(summaryPanel, false);
    toggleCollapsed(resultTablePanel, false);
    return;
  }

  if (deductionsOnly) {
    document.body.classList.add("mode-deductions-only");
    if (modeChip) modeChip.textContent = "Режим: только удержания";
    toggleCollapsed(filterPanel, false);
    toggleCollapsed(restaurantTotalsPanel, false);
    toggleCollapsed(unassignedPanel, false);
    toggleCollapsed(summaryPanel, false);
    toggleCollapsed(resultTablePanel, false);
    return;
  }

  document.body.classList.add("mode-combined");
  if (modeChip) modeChip.textContent = "Режим: объединенный";
  toggleCollapsed(filterPanel, false);
  toggleCollapsed(restaurantTotalsPanel, false);
  toggleCollapsed(unassignedPanel, false);
  toggleCollapsed(summaryPanel, false);
  toggleCollapsed(resultTablePanel, false);
}

function toggleCollapsed(element, collapsed) {
  if (!element) return;
  element.classList.toggle("is-collapsed", collapsed);
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
  baseStatusMessage = "";
  currentMode = { payroll: false, deductions: false };
  applyLayoutMode();
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

clearUi();
if (versionChip) versionChip.textContent = `Версия: ${APP_VERSION}`;
