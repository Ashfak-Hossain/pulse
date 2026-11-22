// Every spelling the parser understands, mapped to one canonical word. Students write Banglish
// however it sounds, so add a variant here when a real sentence is missed; the patterns in
// parse.ts only ever see the canonical form on the left.
export const variants: Readonly<Record<string, readonly string[]>> = {
  // Direction: leaving campus
  jabo: ['jabo', 'jaabo', 'jabe', 'jamu', 'jaibo', 'jaba', 'jacchi', 'jachi', 'jassi', 'jaitesi'],
  going: ['going', 'go', 'leaving', 'leave', 'heading', 'gonna'],
  // Direction: coming to campus
  ashbo: ['ashbo', 'asbo', 'ashbe', 'asbe', 'ashchi', 'aschi', 'ashtesi', 'astesi', 'ashtechi'],
  coming: ['coming', 'come', 'comming'],
  campus: ['campus', 'varsity', 'versity', 'university', 'uni', 'aiub', 'cumpus'],
  home: ['home', 'basa', 'basay', 'bashay', 'basha', 'bashai', 'bari', 'barite', 'bashae'],
  theke: ['theke', 'theika', 'thekey', 'thake', 'tekhe', 'thika'],

  // Time
  tay: ['tay', 'tae', 'tai', 'te', 'tar', 'baje', 'bajay', 'bajhe'],
  por: ['por', 'pore', 'porey', 'poré'],
  shesh: ['shesh', 'sesh', 'sheshe', 'seshe', 'shes', 'ses'],
  class: ['class', 'klass', 'clas', 'classes'],
  ekhon: ['ekhon', 'akhon', 'ekhuni', 'ekhoni', 'akhoni', 'now', 'asap', 'immediately'],
  sare: ['sare', 'saare', 'share', 'sharhe', 'sarhe'],
  poune: ['poune', 'paune', 'pone', 'powne'],
  am: ['am', 'shokal', 'sokal', 'shokale', 'sokale', 'morning'],
  pm: ['pm', 'bikal', 'bikel', 'bikale', 'bikele', 'afternoon', 'evening', 'shondha', 'sondha'],
  raat: ['raat', 'rat', 'ratre', 'night', 'tonight'],

  // Gender
  only: ['only', 'shudhu', 'sudhu', 'shudu', 'sudu', 'shudhumatro', 'sudhumatro', 'just'],
  female: ['female', 'meye', 'maye', 'mey', 'meyer', 'ladies', 'lady', 'girl', 'girls', 'mohila'],
  male: ['male', 'chele', 'sele', 'cheler', 'boy', 'boys', 'gents'],

  // Wait
  wait: ['wait', 'waiting', 'w8', 'opekkha', 'opekha', 'apekkha', 'apekha'],
  min: ['min', 'mins', 'minute', 'minutes', 'minit', 'mint', 'mnt', 'm'],
  hour: ['hour', 'hours', 'hr', 'hrs', 'ghonta', 'ghonda', 'ghanta'],
  half: ['half', 'adha', 'aadha', 'addha', 'adhaa'],

  // Modes
  cng: ['cng', 'auto'],
  rickshaw: ['rickshaw', 'riksha', 'rikshaw', 'riksa', 'rickshow', 'rikshah'],
  uber: ['uber', 'pathao', 'obhai', 'taxi', 'rideshare'],
  bus: ['bus', 'buse', 'baas'],
  mine: ['my', 'amar', 'own', 'nijer'],

  // Number words, so "mirpur ten" and "panch tay" read like the digits
  '1': ['one'],
  '2': ['two', 'dui'],
  '3': ['three', 'tin'],
  '4': ['four', 'char'],
  '5': ['five', 'panch', 'pach'],
  '6': ['six', 'choy', 'chhoy'],
  '7': ['seven', 'saat', 'sat'],
  '8': ['eight', 'aat'],
  '9': ['nine'],
  '10': ['ten', 'dosh', 'dos'],
  '11': ['eleven', 'egaro'],
  '12': ['twelve', 'baro'],
  '15': ['fifteen', 'ponero'],
  '20': ['twenty', 'bish'],
  '30': ['thirty', 'tirish'],
};
