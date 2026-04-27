// api/area.js
// Vercel Serverless Function
// env: JUSO_KEY, BLD_KEY

const BUILD = "2026-04-27-HO-ROWS-9999-01";
const ROWS_PER_PAGE = 9999;
const MAX_PAGES = 20;
const PYEONG_M2 = 3.305785;

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, build: BUILD, message: "GET 요청만 지원합니다." });
  }

  try {
    const address = String(req.query.address || "").trim();
    const floorRaw = req.query.floor != null ? String(req.query.floor).trim() : "";
    const hoInput = req.query.ho != null ? String(req.query.ho).trim() : "";
    const debug = String(req.query.debug || "").trim() === "1";

    if (!address) {
      return res.status(400).json({ ok: false, build: BUILD, message: "address 파라미터가 필요합니다." });
    }
    if (!process.env.JUSO_KEY) {
      return res.status(500).json({ ok: false, build: BUILD, message: "JUSO_KEY 환경변수가 없습니다." });
    }
    if (!process.env.BLD_KEY) {
      return res.status(500).json({ ok: false, build: BUILD, message: "BLD_KEY 환경변수가 없습니다." });
    }

    const juso = await jusoLookup(address);
    const keys = keysFromJuso(juso);

    const flrItems = await fetchBldItems("getBrFlrOulnInfo", keys);
    const floorList = buildFloorList(flrItems);
    const floorNos = floorList.map((x) => String(x.no));

    const floorNorm = normalizeFloor(floorRaw);
    const effectiveFloor =
      floorNorm ||
      (floorList.find((f) => f.gb === "지상")?.no ?? floorList[0]?.no ?? "");

    if (!floorRaw && !hoInput) {
      return res.status(200).json({
        ok: true,
        build: BUILD,
        mode: "summary",
        input: { address, floor: null, ho: null },
        road: juso.roadAddr || "",
        jibun: juso.jibunAddr || "",
        keys,
        floors: floorList,
        floor_nos: floorNos,
      });
    }

    if (!effectiveFloor) {
      return res.status(404).json({
        ok: false,
        build: BUILD,
        message: "층 정보를 찾지 못했습니다.",
        input: { address, floor: floorRaw, ho: hoInput },
        keys,
      });
    }

    if (debug) {
      const dbg = await debugHoSources(keys, effectiveFloor);
      return res.status(200).json({
        ok: true,
        build: BUILD,
        mode: "debug",
        input: { address, floor: effectiveFloor, ho: hoInput },
        road: juso.roadAddr || "",
        jibun: juso.jibunAddr || "",
        keys,
        debug: dbg,
      });
    }

    const floorItems = flrItems.filter((it) => sameFloor(it.flrNo, effectiveFloor));
    const pick = pickBestFloorItem(floorItems);

    if (!hoInput) {
      const { hoList, hoNote, hoIndex } = await collectHoListForFloor(keys, effectiveFloor);
      const floorExclusive = await findFloorExclusiveArea(keys, effectiveFloor);

      return res.status(200).json({
        ok: true,
        build: BUILD,
        mode: "floor",
        input: { address, floor: effectiveFloor, ho: null },
        road: juso.roadAddr || "",
        jibun: juso.jibunAddr || "",
        keys,
        floor_nos: floorNos,
        floor_items: floorItems.map(toClientFloorItem),
        pick: pick ? toClientFloorItem(pick) : null,
        ho_list: hoList,
        ho_list_note: hoNote,
        ho_index: hoIndex,
        floor_exclusive_m2: floorExclusive?.m2 ?? null,
        floor_exclusive_pyeong: floorExclusive?.m2 ? round2(floorExclusive.m2 / PYEONG_M2) : null,
        floor_exclusive_note: floorExclusive?.note ?? null,
      });
    }

    const wantHoNorm = normalizeHo(hoInput);
    if (!wantHoNorm) {
      return res.status(400).json({
        ok: false,
        build: BUILD,
        message: "ho 파라미터에서 호 숫자를 읽지 못했습니다.",
        input: { address, floor: effectiveFloor, ho: hoInput },
      });
    }

    const pubItems = await fetchBldItems("getBrExposPubuseAreaInfo", keys);
    const hoRows = findRowsByFloorAndHo(pubItems, effectiveFloor, wantHoNorm);

    if (hoRows.length) {
      return res.status(200).json(buildHoBreakdownResponse({
        address,
        floor: effectiveFloor,
        hoInput,
        juso,
        keys,
        wantHoNorm,
        hoRows,
      }));
    }

    const exposItems = await fetchBldItems("getBrExposInfo", keys);
    const target = findRowsByFloorAndHo(exposItems, effectiveFloor, wantHoNorm)[0] || null;
    const areaM2 = target ? toNumber(target.area) : 0;

    if (areaM2 > 0) {
      const rawHoNm = String(target.hoNm || "").trim();
      const mergedRange = expandHoRange(rawHoNm);
      const isMerged = mergedRange.length >= 2;

      return res.status(200).json({
        ok: true,
        build: BUILD,
        mode: "exposInfo_fallback",
        input: { address, floor: effectiveFloor, ho: hoInput },
        road: juso.roadAddr || "",
        jibun: juso.jibunAddr || "",
        keys,
        ho_matched: {
          hoNm: target.hoNm,
          flrNo: target.flrNo,
          dongNm: target.dongNm || "",
          merged: isMerged,
          merged_range: isMerged ? mergedRange : null,
          merged_note: isMerged
            ? `입력한 호(${hoInput})는 대장상 "${rawHoNm}" 통합호에 포함되어 조회되었습니다.`
            : null,
        },
        sum: {
          exclusive_m2: areaM2,
          exclusive_pyeong: round2(areaM2 / PYEONG_M2),
          shared_m2: null,
          shared_pyeong: null,
          total_m2: areaM2,
          total_pyeong: round2(areaM2 / PYEONG_M2),
        },
        note: "전유/공용 breakdown 데이터가 없어서 전유부(getBrExposInfo) 면적으로 안내합니다.",
      });
    }

    const floorExclusive = await findFloorExclusiveArea(keys, effectiveFloor);

    if (floorExclusive?.m2) {
      return res.status(200).json({
        ok: true,
        build: BUILD,
        mode: "floorExclusive_fallback",
        input: { address, floor: effectiveFloor, ho: hoInput },
        road: juso.roadAddr || "",
        jibun: juso.jibunAddr || "",
        keys,
        sum: {
          exclusive_m2: floorExclusive.m2,
          exclusive_pyeong: round2(floorExclusive.m2 / PYEONG_M2),
          shared_m2: null,
          shared_pyeong: null,
          total_m2: floorExclusive.m2,
          total_pyeong: round2(floorExclusive.m2 / PYEONG_M2),
        },
        note: "해당 호 데이터가 공공API에서 누락되어, 같은 층의 '전유(hoNm 비어있는)' 면적으로 안내합니다.",
        floor_exclusive_note: floorExclusive.note,
      });
    }

    return res.status(404).json({
      ok: false,
      build: BUILD,
      message: "해당 층/호 면적 데이터를 공공API에서 찾지 못했습니다.",
      input: { address, floor: effectiveFloor, ho: hoInput },
      wantHoNorm,
      hint: "호 전유/공용이 API에 없거나, 호 표기가 다를 수 있습니다. 예: 1306~1308, 1306-1, 1306호 등.",
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      build: BUILD,
      message: e.message || String(e),
    });
  }
};

/* ----------------- JUSO ----------------- */

async function jusoLookup(keyword) {
  const address = normalizeAddressInput(keyword);

  const url = new URL("https://business.juso.go.kr/addrlink/addrLinkApi.do");
  url.searchParams.set("confmKey", process.env.JUSO_KEY);
  url.searchParams.set("currentPage", "1");
  url.searchParams.set("countPerPage", "100");
  url.searchParams.set("keyword", address);
  url.searchParams.set("resultType", "json");

  const response = await fetch(url.toString());
  if (!response.ok) throw new Error(`JUSO HTTP 오류: ${response.status}`);

  const data = await response.json();
  const errorCode = data?.results?.common?.errorCode;
  const errorMessage = data?.results?.common?.errorMessage;

  if (errorCode && errorCode !== "0") {
    throw new Error(`JUSO 오류: ${errorCode} ${errorMessage || ""}`.trim());
  }

  const juso = data?.results?.juso?.[0];
  if (!juso) throw new Error("주소를 찾지 못했습니다. (JUSO 결과 없음)");

  return juso;
}

function keysFromJuso(juso) {
  const admCd = String(juso.admCd || "");

  return {
    sigunguCd: admCd.slice(0, 5),
    bjdongCd: admCd.slice(5, 10),
    bun: String(juso.lnbrMnnm || "0").padStart(4, "0"),
    ji: String(juso.lnbrSlno || "0").padStart(4, "0"),
  };
}

function normalizeAddressInput(s) {
  return String(s || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/([가-힣A-Za-z])(\d)/g, "$1 $2");
}

/* ----------------- Building API ----------------- */

async function fetchBldItems(apiName, keys) {
  let allItems = [];
  let pageNo = 1;
  let totalCount = null;

  while (pageNo <= MAX_PAGES) {
    const url = new URL(`https://apis.data.go.kr/1613000/BldRgstHubService/${apiName}`);
    url.searchParams.set("serviceKey", process.env.BLD_KEY);
    url.searchParams.set("sigunguCd", keys.sigunguCd);
    url.searchParams.set("bjdongCd", keys.bjdongCd);
    url.searchParams.set("bun", keys.bun);
    url.searchParams.set("ji", keys.ji);
    url.searchParams.set("numOfRows", String(ROWS_PER_PAGE));
    url.searchParams.set("pageNo", String(pageNo));

    const response = await fetch(url.toString());
    if (!response.ok) throw new Error(`${apiName} HTTP 오류: ${response.status}`);

    const xml = await response.text();
    assertApiOk(xml, apiName);

    const items = parseItems(xml).map(itemXmlToObj);
    allItems = allItems.concat(items);

    if (totalCount === null) {
      totalCount = Number(getTagFromXml(xml, "totalCount")) || items.length;
    }

    if (!items.length) break;
    if (allItems.length >= totalCount) break;
    if (items.length < ROWS_PER_PAGE) break;

    pageNo += 1;
  }

  return allItems;
}

function assertApiOk(xmlText, apiName) {
  const resultCode = getTagFromXml(xmlText, "resultCode");
  const resultMsg = getTagFromXml(xmlText, "resultMsg");

  if (resultCode && resultCode !== "00") {
    throw new Error(`${apiName} 호출 실패: ${resultCode} ${resultMsg}`.trim());
  }

  if (String(xmlText || "").includes("API not found")) {
    throw new Error(`${apiName} 호출 실패: API not found`);
  }
}

function parseItems(xmlText) {
  return [...String(xmlText || "").matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
}

function getTag(xmlChunk, tag) {
  const m = String(xmlChunk || "").match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return decodeXml(m?.[1]?.trim() || "");
}

function getTagFromXml(xml, tag) {
  return getTag(xml, tag);
}

function itemXmlToObj(item) {
  const tags = [
    "flrNo",
    "flrNoNm",
    "flrGbCdNm",
    "hoNm",
    "dongNm",
    "exposPubuseGbCd",
    "exposPubuseGbCdNm",
    "mainPurpsCdNm",
    "etcPurps",
    "strctCdNm",
    "strctCd",
    "area",
  ];

  const o = {};
  for (const t of tags) o[t] = getTag(item, t);
  return o;
}

function decodeXml(s) {
  return String(s || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/* ----------------- Ho / Floor Helpers ----------------- */

function toNumber(v) {
  const n = Number(String(v || "").trim());
  return Number.isFinite(n) ? n : 0;
}

function round2(n) {
  return Number(Number(n || 0).toFixed(2));
}

function normalizeHo(s) {
  const m = String(s || "").match(/\d+/);
  return m ? m[0] : "";
}

function normalizeFloor(s) {
  const m = String(s || "").match(/-?\d+/);
  return m ? String(Number(m[0])) : "";
}

function sameFloor(a, b) {
  return String(normalizeFloor(a)) === String(normalizeFloor(b));
}

function expandHoRange(hoNm) {
  if (!hoNm) return [];

  const s = String(hoNm)
    .replace(/\s/g, "")
    .replace(/호/g, "")
    .replace(/[–—−]/g, "-");

  const rangeMatch = s.match(/(\d+)\s*[~-]\s*(\d+)/);
  if (rangeMatch) {
    const start = Number(rangeMatch[1]);
    const end = Number(rangeMatch[2]);

    if (start > 0 && end >= start && end - start <= 30) {
      const arr = [];
      for (let i = start; i <= end; i += 1) arr.push(i);
      return arr;
    }
  }

  if (s.includes(",")) {
    return s
      .split(",")
      .map((v) => Number(v.replace(/[^\d]/g, "")))
      .filter((n) => n > 0);
  }

  const single = Number(s.replace(/[^\d]/g, ""));
  return single ? [single] : [];
}

function hoInMergedHoNm(itemHoNm, wantHoNorm) {
  const want = Number(String(wantHoNorm || "").replace(/[^\d]/g, ""));
  if (!want) return false;

  const expanded = expandHoRange(itemHoNm);
  if (!expanded.length) return false;

  return expanded.includes(want);
}

function findRowsByFloorAndHo(items, floor, wantHoNorm) {
  const sameHo = items.filter(
    (it) => sameFloor(it.flrNo, floor) && normalizeHo(it.hoNm || "") === wantHoNorm
  );
  if (sameHo.length) return sameHo;

  return items.filter((it) => {
    if (!sameFloor(it.flrNo, floor)) return false;
    const raw = String(it.hoNm || "").trim();
    return raw ? hoInMergedHoNm(raw, wantHoNorm) : false;
  });
}

function buildFloorList(flrItems) {
  const map = new Map();

  for (const it of flrItems || []) {
    const no = normalizeFloor(it.flrNo || "");
    if (!no) continue;

    const gb = (it.flrGbCdNm || "").includes("지하") ? "지하" : "지상";
    const key = `${gb}:${no}`;

    if (!map.has(key)) map.set(key, { gb, no: String(no) });
  }

  const arr = [...map.values()];
  arr.sort((a, b) => {
    if (a.gb !== b.gb) return a.gb === "지하" ? -1 : 1;
    return Number(a.no) - Number(b.no);
  });

  return arr;
}

function pickBestFloorItem(items) {
  if (!items || !items.length) return null;

  const score = (it) => {
    const area = toNumber(it.area);
    const txt = `${it.mainPurpsCdNm || ""} ${it.etcPurps || ""}`.trim();

    let s = area;
    if (txt.includes("공용")) s -= 100000;
    if (txt.includes("업무") || txt.includes("사무")) s += 50000;

    return s;
  };

  return items.slice().sort((a, b) => score(b) - score(a))[0];
}

function toClientFloorItem(it) {
  const areaM2 = toNumber(it.area);

  return {
    gb: it.flrGbCdNm || "-",
    use: it.mainPurpsCdNm || "-",
    detail: it.etcPurps || "-",
    flrNo: it.flrNo || "",
    flrNoNm: it.flrNoNm || "",
    area_m2: areaM2,
    area_pyeong: round2(areaM2 / PYEONG_M2),
  };
}

function codeToGb(code) {
  const c = String(code || "");
  if (c === "1") return "전유";
  if (c === "2") return "공용";
  return c || "";
}

/* ----------------- Ho Breakdown ----------------- */

function buildHoBreakdownResponse({ address, floor, hoInput, juso, keys, wantHoNorm, hoRows }) {
  const breakdown = hoRows.map((x) => {
    const areaM2 = toNumber(x.area);

    return {
      gb: x.exposPubuseGbCdNm || codeToGb(x.exposPubuseGbCd),
      flrNm: x.flrNoNm || (x.flrNo ? `지상${x.flrNo}층` : ""),
      use: x.mainPurpsCdNm || x.etcPurps || "",
      area_m2: areaM2,
      area_pyeong: round2(areaM2 / PYEONG_M2),
      raw: { flrNo: x.flrNo || "", hoNm: x.hoNm || "" },
    };
  });

  const exclusiveM2 = round2(
    hoRows
      .filter((it) => isExclusiveItem(it))
      .reduce((acc, it) => acc + toNumber(it.area), 0)
  );

  const sharedM2 = round2(
    hoRows
      .filter((it) => isSharedItem(it))
      .reduce((acc, it) => acc + toNumber(it.area), 0)
  );

  const totalM2 = round2(exclusiveM2 + sharedM2);
  const matchedHoNmSamples = Array.from(
    new Set(hoRows.map((r) => String(r.hoNm || "").trim()).filter(Boolean))
  );
  const mergedMatches = matchedHoNmSamples.filter((h) => expandHoRange(h).length >= 2);

  return {
    ok: true,
    build: BUILD,
    mode: "ho_breakdown",
    input: { address, floor, ho: hoInput },
    road: juso.roadAddr || "",
    jibun: juso.jibunAddr || "",
    keys,
    ho_matched: {
      want: hoInput,
      wantHoNorm,
      merged: mergedMatches.length > 0,
      matchedHoNm: mergedMatches[0] || matchedHoNmSamples[0] || null,
      range: mergedMatches[0] ? expandHoRange(mergedMatches[0]) : null,
      note: mergedMatches[0]
        ? `입력한 호(${hoInput})는 대장상 "${mergedMatches[0]}" 통합호에 포함되어 조회되었습니다.`
        : null,
    },
    breakdown,
    sum: {
      exclusive_m2: exclusiveM2 || null,
      exclusive_pyeong: exclusiveM2 ? round2(exclusiveM2 / PYEONG_M2) : null,
      shared_m2: sharedM2 || null,
      shared_pyeong: sharedM2 ? round2(sharedM2 / PYEONG_M2) : null,
      total_m2: totalM2 || null,
      total_pyeong: totalM2 ? round2(totalM2 / PYEONG_M2) : null,
    },
    note: "getBrExposPubuseAreaInfo 기준으로 호별 전유/공용을 구성했습니다.",
  };
}

function isExclusiveItem(it) {
  return String(it.exposPubuseGbCd || "") === "1" || String(it.exposPubuseGbCdNm || "").includes("전유");
}

function isSharedItem(it) {
  return String(it.exposPubuseGbCd || "") === "2" || String(it.exposPubuseGbCdNm || "").includes("공용");
}

/* ----------------- Ho List ----------------- */

async function collectHoListForFloor(keys, floor) {
  const hoIndex = {};
  let hoNote = "";

  const addHo = (hoNm, src) => {
    const raw = String(hoNm || "").trim();
    if (!raw) return;

    const expanded = expandHoRange(raw);
    const norms = expanded.length ? expanded.map(String) : [normalizeHo(raw)].filter(Boolean);

    for (const norm of norms) {
      if (!hoIndex[norm]) {
        hoIndex[norm] = {
          norm,
          samples: [],
          hasExclusive: false,
          exclusive_m2: 0,
          shared_m2: 0,
          total_m2: 0,
          sources: new Set(),
          mergedFrom: expanded.length >= 2 ? raw : null,
        };
      }

      hoIndex[norm].sources.add(src);
      if (!hoIndex[norm].samples.includes(raw)) hoIndex[norm].samples.push(raw);
      if (!hoIndex[norm].mergedFrom && expanded.length >= 2) hoIndex[norm].mergedFrom = raw;
    }
  };

  try {
    const exposItems = await fetchBldItems("getBrExposInfo", keys);
    exposItems
      .filter((it) => sameFloor(it.flrNo, floor))
      .forEach((it) => addHo(it.hoNm, "exposInfo"));
  } catch (e) {
    hoNote += `exposInfo 실패: ${e.message} `;
  }

  try {
    const pubItems = await fetchBldItems("getBrExposPubuseAreaInfo", keys);

    pubItems
      .filter((it) => sameFloor(it.flrNo, floor))
      .forEach((it) => {
        addHo(it.hoNm, "pubuseArea");

        const raw = String(it.hoNm || "").trim();
        const expanded = expandHoRange(raw);
        const norms = expanded.length ? expanded.map(String) : [normalizeHo(raw)].filter(Boolean);
        const area = toNumber(it.area);

        for (const norm of norms) {
          if (!hoIndex[norm]) continue;

          if (isExclusiveItem(it)) {
            hoIndex[norm].hasExclusive = true;
            hoIndex[norm].exclusive_m2 += area;
          }
          if (isSharedItem(it)) {
            hoIndex[norm].shared_m2 += area;
          }
        }
      });
  } catch (e) {
    hoNote += `pubuseArea 실패: ${e.message} `;
  }

  for (const v of Object.values(hoIndex)) {
    v.exclusive_m2 = round2(v.exclusive_m2);
    v.shared_m2 = round2(v.shared_m2);
    v.total_m2 = round2(v.exclusive_m2 + v.shared_m2);
    v.exclusive_pyeong = v.exclusive_m2 ? round2(v.exclusive_m2 / PYEONG_M2) : null;
    v.shared_pyeong = v.shared_m2 ? round2(v.shared_m2 / PYEONG_M2) : null;
    v.total_pyeong = v.total_m2 ? round2(v.total_m2 / PYEONG_M2) : null;
    v.sources = [...v.sources];
  }

  const hoList = Object.keys(hoIndex).sort((a, b) => Number(a) - Number(b));

  if (!hoList.length) hoNote += "해당 층에서 호 목록을 찾지 못했습니다.";

  return { hoList, hoNote: hoNote.trim(), hoIndex };
}

/* ----------------- Floor Exclusive ----------------- */

async function findFloorExclusiveArea(keys, floor) {
  try {
    const pubItems = await fetchBldItems("getBrExposPubuseAreaInfo", keys);

    const candidates = pubItems.filter((it) => {
      if (!sameFloor(it.flrNo, floor)) return false;
      if (!isExclusiveItem(it)) return false;

      const hoRaw = String(it.hoNm || "").trim();
      const hoNorm = normalizeHo(hoRaw);

      return !hoRaw || !hoNorm;
    });

    if (!candidates.length) return null;

    candidates.sort((a, b) => toNumber(b.area) - toNumber(a.area));

    const best = candidates[0];
    const m2 = toNumber(best.area);

    if (!m2) return null;

    return {
      m2,
      note: `getBrExposPubuseAreaInfo: flrNo=${best.flrNo}, gb=${best.exposPubuseGbCdNm || best.exposPubuseGbCd}, hoNm="${best.hoNm || ""}"`,
    };
  } catch {
    return null;
  }
}

/* ----------------- Debug ----------------- */

async function debugHoSources(keys, floor) {
  const out = {};
  const apis = ["getBrExposInfo", "getBrExposPubuseAreaInfo", "getBrFlrOulnInfo"];

  for (const api of apis) {
    try {
      const items = await fetchBldItems(api, keys);
      const floorItems = items.filter((it) => sameFloor(it.flrNo, floor));

      out[api] = {
        total: items.length,
        floorCount: floorItems.length,
        hoNmSamples: floorItems.map((it) => it.hoNm).filter(Boolean).slice(0, 100),
      };
    } catch (e) {
      out[api] = { error: e.message };
    }
  }

  return out;
}
