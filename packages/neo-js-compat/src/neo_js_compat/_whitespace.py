"""Shared ECMAScript whitespace data."""

# ECMAScript ``WhiteSpace`` plus ``LineTerminator``.  In particular, U+0085
# is intentionally absent: Python ``str.strip`` removes it, but JS does not.
# U+FEFF is intentionally present: Python does not remove it.
ECMASCRIPT_WHITESPACE = (
    "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680"
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000\ufeff"
)
ECMASCRIPT_TRIM = frozenset(ECMASCRIPT_WHITESPACE)
