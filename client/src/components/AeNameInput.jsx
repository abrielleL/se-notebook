import { useEffect, useId, useState } from 'react';
import { api } from '../lib/api.js';

// AE field backed by the roster in Settings.
//
// A datalist rather than a select, because the AE on a deal is sometimes
// someone who was never added to the roster -- the field has to stay free
// text. The actual first-name-to-full-name expansion happens server-side
// (server/lib/aeRoster.js) so it applies no matter which form wrote the value;
// this component is only the suggestion surface.
export default function AeNameInput({ value, onChange, className, placeholder = 'e.g. Rob' }) {
  const [names, setNames] = useState([]);
  const listId = useId();

  useEffect(() => {
    api.listAeRoster().then(r => setNames(r.map(a => a.full_name))).catch(() => {});
  }, []);

  return (
    <>
      <input
        value={value}
        onChange={onChange}
        className={className}
        placeholder={placeholder}
        list={names.length ? listId : undefined}
        autoComplete="off"
        spellCheck={false} />
      {names.length > 0 &&
        <datalist id={listId}>{names.map(n => <option key={n} value={n} />)}</datalist>}
    </>
  );
}
