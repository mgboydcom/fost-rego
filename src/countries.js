// The allowed values for users.country: ISO 3166-1 alpha-2 codes, with English names.
const CODES = `AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW
BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO
FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO
JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS
MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU
RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA
UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW`.split(/\s+/);

const names = new Intl.DisplayNames(['en'], { type: 'region' });
const COUNTRIES = CODES.map((code) => ({ code, name: names.of(code) }))
  .sort((a, b) => a.name.localeCompare(b.name, 'en'));
const BY_CODE = new Map(COUNTRIES.map((c) => [c.code, c.name]));

const isCountryCode = (code) => BY_CODE.has(code);
const countryName = (code) => BY_CODE.get(code) || '';

const ALIASES = { uk: 'GB', 'united kingdom': 'GB', england: 'GB', scotland: 'GB', wales: 'GB', usa: 'US', us: 'US',
  'united states of america': 'US', america: 'US', holland: 'NL', 'south korea': 'KR', korea: 'KR', russia: 'RU',
  'czech republic': 'CZ', uae: 'AE', 'ivory coast': 'CI' };
const fold = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, "'").toLowerCase().trim();
const BY_NAME = new Map(COUNTRIES.map((c) => [fold(c.name), c.code]));

// Best guess at a country code from free text such as "Paris, France". Returns '' when unsure.
function guessCountryCode(text) {
  const parts = String(text || '').split(',').map(fold).filter(Boolean);
  for (const part of parts.reverse()) {
    if (BY_NAME.has(part)) return BY_NAME.get(part);
    if (ALIASES[part]) return ALIASES[part];
  }
  return '';
}

module.exports = { COUNTRIES, isCountryCode, countryName, guessCountryCode };
