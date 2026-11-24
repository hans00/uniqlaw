#!/usr/bin/env python3
"""Build tokenizer-words.txt.gz and t2s-chars.txt.gz (see tokenizer-words.NOTICE). Standard library only.

  python3 -I build-tokenizer-words.py <Qwen3.5 tokenizer.json> <OpenCC TSCharacters.txt>

tokenizer-words.txt.gz: the whole-word tokens of the Qwen3.5 vocabulary, one per line, sorted:
  - CJK (Han, kana, Hangul) tokens of 2+ characters, as they are;
  - word-start tokens (a leading space, then 3+ letters, no CJK) of any other script, lower case, without the space.
t2s-chars.txt.gz: one "<traditional>\t<simplified>" pair per line (OpenCC's first choice), for looking up Traditional
Chinese text in a vocabulary that is mostly Simplified.
"""
import gzip, json, re, sys

CJK = "぀-ヿ㐀-䶿一-鿿豈-﫿가-힯々ー"


def byte_decoder():
    bs = list(range(ord("!"), ord("~") + 1)) + list(range(ord("¡"), ord("¬") + 1)) + list(range(ord("®"), ord("ÿ") + 1))
    cs = bs[:]
    n = 0
    for b in range(256):
        if b not in bs:
            bs.append(b)
            cs.append(256 + n)
            n += 1
    return {chr(c): b for b, c in zip(bs, cs)}


def write_gz(path, lines):
    with open(path, "wb") as f, gzip.GzipFile(fileobj=f, mode="wb", compresslevel=9, mtime=0, filename="") as g:
        g.write(("\n".join(lines) + "\n").encode("utf-8"))


def main(tokenizer_json, ts_characters):
    u2b = byte_decoder()
    words = set()
    for tok in json.load(open(tokenizer_json, encoding="utf-8"))["model"]["vocab"]:
        try:
            s = bytes(u2b[ch] for ch in tok).decode("utf-8")
        except (KeyError, UnicodeDecodeError):
            continue
        if re.fullmatch(f"[{CJK}]{{2,}}", s):
            words.add(s)
        elif re.fullmatch(r" [^\W\d_]{3,}", s) and not re.search(f"[{CJK}]", s):
            words.add(s[1:].lower())
    write_gz("tokenizer-words.txt.gz", sorted(words))
    pairs = []
    for line in open(ts_characters, encoding="utf-8"):
        p = line.rstrip("\n").split("\t")
        if len(p) == 2 and len(p[0]) == 1 and len(p[1].split(" ")[0]) == 1 and p[0] != p[1].split(" ")[0]:
            pairs.append(f"{p[0]}\t{p[1].split(' ')[0]}")
    write_gz("t2s-chars.txt.gz", sorted(pairs))
    print(len(words), "words,", len(pairs), "character pairs")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
