//! Minimal, allocation-free JSON structural scanner for one purpose: pull
//! named string fields out of a Phala ACI receipt document (`aci-protocol`'s
//! JCS output, see `receipt.rs`) without pulling in a full JSON library.
//!
//! The receipt bytes only reach here after the Ed25519 signature over them
//! has already verified, so they are exactly the bytes Phala's TEE signed:
//! well-formed JSON, ASCII only, integer-only numbers (Appendix A of the ACI
//! spec). This scanner still walks the structure byte-by-byte (not a raw
//! substring search) so a string *value* that happens to contain `"key":`
//! text can never be mistaken for a structural key.
//!
//! ponytail: string values are returned as their raw un-escaped bytes
//! between the quotes (no `\uXXXX`/`\"` decoding). Every field this crate
//! reads (`model`, `model_id`, `type`, `result`, `body_hash`) is a plain
//! identifier or `sha256:`+hex digest in the real format and never carries a
//! JSON escape. Upgrade to full escape decoding if Phala ever emits one.

#[derive(Debug, PartialEq, Eq)]
pub struct JsonError;

type R<T> = Result<T, JsonError>;

/// Skip one JSON string starting at `b[i] == b'"'`. Returns the index just
/// past the closing quote.
fn skip_string(b: &[u8], i: usize) -> R<usize> {
    if b.get(i) != Some(&b'"') {
        return Err(JsonError);
    }
    let mut j = i + 1;
    loop {
        match b.get(j) {
            None => return Err(JsonError),
            Some(b'"') => return Ok(j + 1),
            Some(b'\\') => j += 2, // skip escape pair; JCS output never breaks mid-escape
            Some(_) => j += 1,
        }
    }
}

/// Skip one JSON value (string, object, array, number, or true/false/null)
/// starting at `b[i]`. Returns the index just past the value.
fn skip_value(b: &[u8], i: usize) -> R<usize> {
    match b.get(i) {
        Some(b'"') => skip_string(b, i),
        Some(b'{') => skip_container(b, i, b'{', b'}'),
        Some(b'[') => skip_container(b, i, b'[', b']'),
        Some(b't') => skip_literal(b, i, b"true"),
        Some(b'f') => skip_literal(b, i, b"false"),
        Some(b'n') => skip_literal(b, i, b"null"),
        Some(c) if *c == b'-' || c.is_ascii_digit() => skip_number(b, i),
        _ => Err(JsonError),
    }
}

fn skip_literal(b: &[u8], i: usize, lit: &[u8]) -> R<usize> {
    if b.get(i..i + lit.len()) == Some(lit) {
        Ok(i + lit.len())
    } else {
        Err(JsonError)
    }
}

fn skip_number(b: &[u8], i: usize) -> R<usize> {
    let mut j = i;
    if b.get(j) == Some(&b'-') {
        j += 1;
    }
    let start = j;
    while b.get(j).is_some_and(u8::is_ascii_digit) {
        j += 1;
    }
    if j == start {
        return Err(JsonError);
    }
    Ok(j)
}

/// Skip a `{...}` object or `[...]` array, tracking nesting only through the
/// recursive `skip_value` calls (strings can never confuse the bracket
/// count because they are always skipped whole by `skip_string`).
fn skip_container(b: &[u8], i: usize, open: u8, close: u8) -> R<usize> {
    if b.get(i) != Some(&open) {
        return Err(JsonError);
    }
    let mut j = i + 1;
    if b.get(j) == Some(&close) {
        return Ok(j + 1);
    }
    loop {
        if open == b'{' {
            j = skip_string(b, j)?; // key
            if b.get(j) != Some(&b':') {
                return Err(JsonError);
            }
            j += 1;
        }
        j = skip_value(b, j)?;
        match b.get(j) {
            Some(b',') => j += 1,
            Some(c) if *c == close => return Ok(j + 1),
            _ => return Err(JsonError),
        }
    }
}

/// Find `"key"` as a member of the object starting at `b[obj_start] == '{'`
/// (not searched recursively into nested members) and return the byte range
/// of its raw JSON value `(start, end)`, or `None` if the object has no such
/// key. Errors only on malformed JSON.
pub fn find_member(b: &[u8], obj_start: usize, key: &str) -> R<Option<(usize, usize)>> {
    if b.get(obj_start) != Some(&b'{') {
        return Err(JsonError);
    }
    let mut j = obj_start + 1;
    if b.get(j) == Some(&b'}') {
        return Ok(None);
    }
    loop {
        let key_start = j;
        j = skip_string(b, j)?;
        let found_key = &b[key_start + 1..j - 1];
        if b.get(j) != Some(&b':') {
            return Err(JsonError);
        }
        j += 1;
        let value_start = j;
        let value_end = skip_value(b, j)?;
        if found_key == key.as_bytes() {
            return Ok(Some((value_start, value_end)));
        }
        j = value_end;
        match b.get(j) {
            Some(b',') => j += 1,
            Some(b'}') => return Ok(None),
            _ => return Err(JsonError),
        }
    }
}

/// Iterate the elements of the array starting at `b[arr_start] == '['`,
/// calling `f` with each element's raw byte range, stopping early if `f`
/// returns `Some`.
pub fn find_array_element<T>(
    b: &[u8],
    arr_start: usize,
    mut f: impl FnMut(&[u8], usize, usize) -> R<Option<T>>,
) -> R<Option<T>> {
    if b.get(arr_start) != Some(&b'[') {
        return Err(JsonError);
    }
    let mut j = arr_start + 1;
    if b.get(j) == Some(&b']') {
        return Ok(None);
    }
    loop {
        let elem_start = j;
        let elem_end = skip_value(b, j)?;
        if let Some(found) = f(b, elem_start, elem_end)? {
            return Ok(Some(found));
        }
        j = elem_end;
        match b.get(j) {
            Some(b',') => j += 1,
            Some(b']') => return Ok(None),
            _ => return Err(JsonError),
        }
    }
}

/// Read a raw JSON string value's content bytes (quotes stripped, no escape
/// decoding — see module doc). `start` must be the index of the opening
/// quote as returned by [`find_member`]/[`find_array_element`].
pub fn string_content<'a>(b: &'a [u8], start: usize, end: usize) -> R<&'a [u8]> {
    if end < start + 2 || b[start] != b'"' || b[end - 1] != b'"' {
        return Err(JsonError);
    }
    Ok(&b[start + 1..end - 1])
}

/// Convenience: find a top-level string member and return its content
/// bytes, or `None` if the key is absent or its value is JSON `null`.
pub fn find_string_member<'a>(b: &'a [u8], obj_start: usize, key: &str) -> R<Option<&'a [u8]>> {
    match find_member(b, obj_start, key)? {
        None => Ok(None),
        Some((s, e)) if b.get(s) == Some(&b'n') => {
            let _ = skip_literal(b, s, b"null")?;
            let _ = e;
            Ok(None)
        }
        Some((s, e)) => Ok(Some(string_content(b, s, e)?)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_flat_member() {
        let doc = br#"{"a":"x","b":42,"c":"y"}"#;
        let (s, e) = find_member(doc, 0, "c").unwrap().unwrap();
        assert_eq!(string_content(doc, s, e).unwrap(), b"y");
    }

    #[test]
    fn missing_member_is_none() {
        let doc = br#"{"a":"x"}"#;
        assert_eq!(find_member(doc, 0, "zzz").unwrap(), None);
    }

    #[test]
    fn null_member_reads_as_none() {
        let doc = br#"{"model":null,"other":"x"}"#;
        assert_eq!(find_string_member(doc, 0, "model").unwrap(), None);
    }

    #[test]
    fn string_value_containing_fake_key_is_not_mistaken_for_structure() {
        // The value text itself contains `"model":"evil"` — a substring
        // scanner would find this; a structural scanner must not.
        let doc = br#"{"reason":"payload had \"model\":\"evil\" in it","model":"real"}"#;
        let (s, e) = find_member(doc, 0, "model").unwrap().unwrap();
        assert_eq!(string_content(doc, s, e).unwrap(), b"real");
    }

    #[test]
    fn walks_nested_array_of_objects() {
        let doc = br#"{"event_log":[{"type":"a","x":1},{"type":"b","x":2}]}"#;
        let (arr_s, _arr_e) = find_member(doc, 0, "event_log").unwrap().unwrap();
        let found = find_array_element(doc, arr_s, |b, es, ee| {
            let (ks, ke) = find_member(b, es, "type")?.ok_or(JsonError)?;
            if string_content(b, ks, ke)? == b"b" {
                Ok(Some((es, ee)))
            } else {
                Ok(None)
            }
        })
        .unwrap()
        .unwrap();
        let (xs, xe) = find_member(doc, found.0, "x").unwrap().unwrap();
        assert_eq!(&doc[xs..xe], b"2");
    }

    #[test]
    fn malformed_json_errors_not_panics() {
        assert!(find_member(br#"{"a":"unterminated"#, 0, "a").is_err());
        assert!(find_member(br#"{"a":}"#, 0, "a").is_err());
        assert!(skip_value(br#"nul"#, 0).is_err());
    }
}
