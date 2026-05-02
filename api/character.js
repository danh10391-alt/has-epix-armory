'use strict';

const https = require('https');
const path  = require('path');
const fs    = require('fs');

const CLIENT_ID     = '5f3738add0b24ac98330ae54297e0ebf';
const CLIENT_SECRET = '1xl9pT7JdMwd64hDHsc7KsHmbjugTpGs';
const REALM_SLUG    = 'thunderstrike';
const REGION        = 'eu';
const LOCALE        = 'en_GB';
const PROFILE_NS    = 'profile-classicann-eu';
const STATIC_NS     = 'static-classicann-eu';

const CLASS_COLORS = {
  1:'#C79C6E',2:'#F58CBA',3:'#ABD473',4:'#FFF569',
  5:'#FFFFFF',6:'#C41F3B',7:'#0070DE',8:'#69CCF0',
  9:'#9482C9',10:'#00FF96',11:'#FF7D0A',
};
const CLASS_ICONS = {
  1:'classicon_warrior',2:'classicon_paladin',3:'classicon_hunter',
  4:'classicon_rogue',5:'classicon_priest',6:'classicon_deathknight',
  7:'classicon_shaman',8:'classicon_mage',9:'classicon_warlock',
  10:'classicon_monk',11:'classicon_druid',
};
const QUALITY_COLORS = {
  0:'#9d9d9d',1:'#ffffff',2:'#1eff00',3:'#0070dd',4:'#a335ee',5:'#ff8000',
};
const SLOT_ORDER = [
  'HEAD','NECK','SHOULDER','BACK','CHEST','WRIST',
  'HANDS','WAIST','LEGS','FEET','FINGER_1','FINGER_2',
  'TRINKET_1','TRINKET_2','MAIN_HAND','OFF_HAND','RANGED',
];
const SLOT_LABELS = {
  HEAD:'Head', NECK:'Neck', SHOULDER:'Shoulder', BACK:'Back',
  CHEST:'Chest', WRIST:'Wrist', HANDS:'Hands', WAIST:'Waist',
  LEGS:'Legs', FEET:'Feet', FINGER_1:'Finger 1', FINGER_2:'Finger 2',
  TRINKET_1:'Trinket 1', TRINKET_2:'Trinket 2',
  MAIN_HAND:'Main Hand', OFF_HAND:'Off Hand', RANGED:'Ranged',
};

let talentPositions = null;
function getTalentPositions() {
  if (!talentPositions) {
    const p = path.join(__dirname, 'talent_positions.json');
    talentPositions = JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  return talentPositions;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, body: buf, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('timeout')); });
  });
}

function httpGetJson(url, headers = {}) {
  return httpGet(url, headers).then(r => {
    try { return { status: r.status, data: JSON.parse(r.body.toString()) }; }
    catch { return { status: r.status, data: null }; }
  });
}

function fetchBase64(url) {
  return httpGet(url).then(r => {
    if (r.status !== 200) return null;
    const mime = r.headers['content-type'] || 'image/jpeg';
    return `data:${mime};base64,${r.body.toString('base64')}`;
  }).catch(() => null);
}

// ── Blizzard auth ─────────────────────────────────────────────────────────────
let cachedToken = null;
let tokenExpiry  = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const body   = 'grant_type=client_credentials';
  const result = await new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: `${REGION}.battle.net`, path: '/oauth/token', method: 'POST',
        headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }},
      (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
  cachedToken = result.access_token;
  tokenExpiry  = Date.now() + (result.expires_in - 60) * 1000;
  return cachedToken;
}

function blizzardUrl(urlPath, ns, extra = '') {
  return `https://${REGION}.api.blizzard.com${urlPath}?namespace=${ns}&locale=${LOCALE}${extra}`;
}

async function blizzGet(url, token) {
  return httpGetJson(url, { Authorization: `Bearer ${token}` });
}

// ── Icon fetching ─────────────────────────────────────────────────────────────
const iconCache = new Map();

async function fetchIconBase64(iconName) {
  if (!iconName) return null;
  const key = iconName.toLowerCase();
  if (iconCache.has(key)) return iconCache.get(key);
  const url = `https://wow.zamimg.com/images/wow/icons/large/${key}.jpg`;
  const data = await fetchBase64(url);
  iconCache.set(key, data);
  return data;
}

// ── Item static data ──────────────────────────────────────────────────────────
const itemCache = new Map();

async function fetchItemStatic(itemId, token) {
  if (itemCache.has(itemId)) return itemCache.get(itemId);
  const url = blizzardUrl(`/data/wow/item/${itemId}`, STATIC_NS);
  const { status, data } = await blizzGet(url, token);
  if (status !== 200 || !data) { itemCache.set(itemId, null); return null; }

  // Extract sockets
  const socketTypes = [];
  if (data.preview_item && data.preview_item.sockets) {
    data.preview_item.sockets.forEach(s => {
      socketTypes.push(s.socket_type ? s.socket_type.type : 'PRISMATIC');
    });
  }

  // Extract stats — convert to {display, is_equip}
  const stats = [];
  if (data.preview_item && data.preview_item.stats) {
    data.preview_item.stats.forEach(s => {
      const disp = s.display ? s.display.display_string : '';
      stats.push({ display: disp, is_equip: false });
    });
  }

  // Extract spells/equip effects — convert to {description}
  const spells = [];
  if (data.preview_item && data.preview_item.spells) {
    data.preview_item.spells.forEach(s => {
      if (s.description) spells.push({ description: s.description });
    });
  }

  const result = {
    item_level: data.level || 0,
    socket_count: socketTypes.length,
    socket_types: socketTypes,
    stats,
    spells,
    set_name: data.item_set ? data.item_set.name : null,
    required_level: data.required_level || 0,
    item_type: data.item_subclass ? data.item_subclass.name : null,
    binding: data.preview_item && data.preview_item.binding ? data.preview_item.binding.name : null,
    armor: data.preview_item && data.preview_item.armor ? data.preview_item.armor.value : null,
    weapon: data.preview_item && data.preview_item.weapon ? data.preview_item.weapon : null,
    durability: data.preview_item && data.preview_item.durability ? `Durability ${data.preview_item.durability.value}` : null,
  };
  itemCache.set(itemId, result);
  return result;
}

// ── Build equipment list ───────────────────────────────────────────────────────
async function buildEquipment(equippedItems, token) {
  const gearMap = {};
  await Promise.all(equippedItems.map(async (item) => {
    const slotType = item.slot ? item.slot.type : null;
    if (!slotType) return;

    const itemId   = item.item ? item.item.id : null;
    const quality  = item.quality ? item.quality.type : 'COMMON';
    const qualityN = quality.charAt(0) + quality.slice(1).toLowerCase();
    const qualIdx  = ['Poor','Common','Uncommon','Rare','Epic','Legendary'].indexOf(qualityN);
    const qualColor = QUALITY_COLORS[qualIdx >= 0 ? qualIdx : 1];

    // Fetch icon — extract icon name and fetch as base64
    let iconData = null;
    let iconName = null;
    const mediaHref = item.media && item.media.key ? item.media.key.href : null;
    if (mediaHref) {
      const { data: mediaData } = await blizzGet(mediaHref, token).catch(() => ({ data: null }));
      const iconUrl = mediaData && mediaData.assets ? (mediaData.assets.find(a => a.key === 'icon') || {}).value : null;
      if (iconUrl) {
        const match = iconUrl.match(/icons\/large\/(.+?)(?:\.jpg)?$/i);
        if (match) {
          iconName = match[1].toLowerCase();
          iconData = await fetchIconBase64(iconName);
        } else {
          iconData = await fetchBase64(iconUrl);
        }
      }
    }

    // Fetch static data for stats/sockets
    let staticData = null;
    if (itemId) staticData = await fetchItemStatic(itemId, token);

    // Enchantments → [{display}]
    const enchantments = [];
    if (item.enchantments && item.enchantments.length > 0) {
      item.enchantments.forEach(e => {
        const disp = e.display_string || String(e.enchantment_id || '');
        if (disp) enchantments.push({ display: disp });
      });
    }

    // Build sockets array: start with static socket_types, fill in equipped gems
    const gemsBySlot = {};
    if (item.sockets) {
      item.sockets.forEach((s, i) => {
        gemsBySlot[i] = s.item ? s.item.name : null;
      });
    }
    const sockets = (staticData ? staticData.socket_types : []).map((sockType, i) => ({
      socket_type: sockType,
      gem_name: gemsBySlot[i] || null,
    }));

    gearMap[slotType] = {
      id: itemId,
      name: item.name || '',
      slot: slotType,
      slot_label: SLOT_LABELS[slotType] || slotType,
      quality: qualityN,
      quality_color: qualColor,
      icon: iconName,
      icon_data: iconData,
      item_level: staticData ? staticData.item_level : 0,
      binding: staticData ? staticData.binding : null,
      item_type: staticData ? staticData.item_type : null,
      armor: staticData ? staticData.armor : null,
      stats: staticData ? staticData.stats : [],
      spells: staticData ? staticData.spells : [],
      enchantments,
      sockets,
      durability: staticData ? staticData.durability : null,
      set_name: staticData ? staticData.set_name : null,
    };
  }));

  return SLOT_ORDER.map(slot => gearMap[slot] || null).filter(Boolean);
}

// ── Build talents ─────────────────────────────────────────────────────────────
async function buildTalents(charData, specData, token) {
  const classId = charData.character_class ? charData.character_class.id : null;
  if (!classId) {
    return { trees: [], spec_summary: '', total_points: 0, tree_names: [] };
  }

  const positions = getTalentPositions();
  const classKey  = String(classId);
  const classTalents = positions[classKey] || {};

  // Get spent talents from spec data
  const spentMap = {};
  if (specData && specData.specializations) {
    specData.specializations.forEach(spec => {
      if (spec.talents) {
        spec.talents.forEach(t => {
          const sid = t.spell_tooltip && t.spell_tooltip.spell ? t.spell_tooltip.spell.id : null;
          const tid = t.talent ? t.talent.id : null;
          if (tid) spentMap[tid] = t.talent_rank || 1;
          if (sid) spentMap[`spell_${sid}`] = t.talent_rank || 1;
        });
      }
    });
  }

  // Build trees — return as {name, spent_points, talents}
  const treeNames = Object.keys(classTalents);
  const trees = [];
  for (const treeName of treeNames) {
    const talents = classTalents[treeName];
    const talentList = [];
    for (const talent of talents) {
      const iconData = talent.icon ? await fetchIconBase64(talent.icon) : null;
      const rank = spentMap[talent.talent_id] || spentMap[`spell_${talent.spell_id}`] || 0;
      talentList.push({
        talent_id: talent.talent_id,
        spell_id: talent.spell_id,
        name: talent.name,
        description: talent.description || '',
        icon: talent.icon,
        icon_data: iconData,
        max_rank: talent.max_rank || 5,
        rank,
        row: talent.row,
        col: talent.col,
      });
    }
    const spent_points = talentList.reduce((sum, t) => sum + (t.rank || 0), 0);
    trees.push({ name: treeName, spent_points, talents: talentList });
  }

  // Determine spec summary (tree with most points)
  const topTree = [...trees].sort((a, b) => b.spent_points - a.spent_points)[0];
  const total_points = trees.reduce((sum, t) => sum + t.spent_points, 0);
  const spec_summary = topTree && topTree.spent_points > 0
    ? `${topTree.spent_points}/${trees.filter(t => t.name !== topTree.name).map(t => t.spent_points).join('/')}`
    : '';

  return { trees, spec_summary, total_points, tree_names: treeNames };
}

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const name = (req.query.name || '').trim().toLowerCase();
  if (!name) {
    res.status(400).json({ error: 'Missing name parameter' });
    return;
  }

  try {
    const token = await getToken();

    // Fetch character + equipment + specs in parallel
    const [charRes, equipRes, specRes] = await Promise.all([
      blizzGet(blizzardUrl(`/profile/wow/character/${REALM_SLUG}/${name}`, PROFILE_NS), token),
      blizzGet(blizzardUrl(`/profile/wow/character/${REALM_SLUG}/${name}/equipment`, PROFILE_NS), token),
      blizzGet(blizzardUrl(`/profile/wow/character/${REALM_SLUG}/${name}/specializations`, PROFILE_NS), token).catch(() => ({ data: null })),
    ]);

    if (charRes.status === 404 || !charRes.data || charRes.data.code === 404) {
      res.status(404).json({ error: `Character "${name}" not found on Thunderstrike EU. Check the name spelling and try again.` });
      return;
    }
    if (charRes.status !== 200) {
      res.status(500).json({ error: `Blizzard API error ${charRes.status} for character lookup` });
      return;
    }

    const charData  = charRes.data;
    const equipData = equipRes.data || {};
    const specData  = specRes.data || {};

    const classId    = charData.character_class ? charData.character_class.id : null;
    const className  = charData.character_class ? charData.character_class.name : 'Unknown';
    const raceId     = charData.race ? charData.race.id : null;
    const raceName   = charData.race ? charData.race.name : 'Unknown';
    const classColor = CLASS_COLORS[classId] || '#FFFFFF';

    const avatarUrl    = charData.render_url || null;
    const classIconKey = CLASS_ICONS[classId] || 'classicon_warrior';

    const [equipment, talents, avatarData, classIconData] = await Promise.all([
      buildEquipment(equipData.equipped_items || [], token),
      buildTalents(charData, specData, token),
      avatarUrl ? fetchBase64(avatarUrl) : Promise.resolve(null),
      fetchIconBase64(classIconKey),
    ]);

    // Return in the shape the React app expects: { character, equipment, talents }
    res.status(200).json({
      character: {
        name: charData.name || name,
        level: charData.level || 0,
        class_id: classId,
        class_name: className,
        class_color: classColor,
        race_id: raceId,
        race_name: raceName,
        faction: charData.faction ? charData.faction.name : 'Unknown',
        realm: 'Thunderstrike',
        region: 'EU',
        gender: charData.gender ? charData.gender.name : null,
        average_item_level: charData.average_item_level || 0,
        equipped_item_level: charData.equipped_item_level || 0,
        avatar: avatarUrl,
        avatar_data: avatarData,
        class_icon_data: classIconData,
        last_login: null,
      },
      equipment,
      talents,
    });
  } catch (err) {
    console.error('Handler error:', err);
    res.status(500).json({ error: `Server error: ${err.message}` });
  }
};
