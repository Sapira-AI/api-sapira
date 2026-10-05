const partes = document.cookie.split('; ')
  .map(c => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)])
  .filter(([k]) => /^sb-.+-auth-token(\.\d+)?$/.test(k))
  .sort(([a], [b]) => Number(a.split('.')[1] ?? 0) - Number(b.split('.')[1] ?? 0));

let raw = decodeURIComponent(partes.map(([, v]) => v).join(''));
if (raw.startsWith('base64-')) raw = atob(raw.slice(7));

const sesion = JSON.parse(raw);
copy(sesion.access_token);          // queda en el portapapeles
console.log(sesion.user.id);        // tu auth uid, lo necesitás para el holding
