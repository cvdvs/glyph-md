#import "GlyphHighlighter.h"
#import "GlyphTheme.h"

typedef NS_ENUM(uint8_t, GlyphLineKind) {
    GlyphLinePlain = 0,
    GlyphLineFrontmatterDelim,
    GlyphLineFrontmatterBody,
    GlyphLineFenceMarker,
    GlyphLineFenceBody,
    GlyphLineTableHeader,
    GlyphLineTableDelim,
    GlyphLineTableRow,
};

static NSRegularExpression *RX(NSString *pattern) {
    NSError *err = nil;
    NSRegularExpression *r = [NSRegularExpression regularExpressionWithPattern:pattern
                                                                      options:0
                                                                        error:&err];
    NSCAssert(r, @"bad pattern %@: %@", pattern, err);
    return r;
}

@interface GlyphHighlighter ()
@property (nonatomic, weak) NSTextView *textView;
@property (nonatomic, weak) NSTextStorage *textStorage;
@property (nonatomic, assign) BOOL bulk;
@property (nonatomic, assign) BOOL stale;
@property (nonatomic, strong) NSMutableData *starts;   // NSUInteger per line
@property (nonatomic, strong) NSMutableData *ends;     // NSUInteger per line (contents end)
@property (nonatomic, strong) NSMutableData *kinds;    // uint8_t per line
@property (nonatomic, strong) NSMutableData *info;     // uint8_t per line: fence lang len / table col
@end

@implementation GlyphHighlighter

- (instancetype)initWithTextView:(NSTextView *)textView {
    self = [super init];
    if (self) {
        _textView = textView;
        _textStorage = textView.textStorage;
        _starts = [NSMutableData data];
        _ends = [NSMutableData data];
        _kinds = [NSMutableData data];
        _info = [NSMutableData data];
        _enabled = NO;
        _textStorage.delegate = self;
        [self rescanStructure];
    }
    return self;
}

#pragma mark - Structure model

- (NSUInteger *)startsPtr { return (NSUInteger *)self.starts.mutableBytes; }
- (NSUInteger *)endsPtr { return (NSUInteger *)self.ends.mutableBytes; }
- (uint8_t *)kindsPtr { return (uint8_t *)self.kinds.mutableBytes; }

- (NSUInteger)lineCount { return self.starts.length / sizeof(NSUInteger); }

static BOOL IsBlankOrWS(NSString *s) {
    return [s stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet].length == 0;
}

// A fence opener: up to 3 spaces, then >=3 backticks or tildes. Returns the run
// length and character, 0 if not a fence.
static NSUInteger FenceRun(NSString *line, unichar *outChar, NSString **outInfo) {
    NSUInteger i = 0, n = line.length;
    while (i < n && i < 4 && (([line characterAtIndex:i] == ' ') || ([line characterAtIndex:i] == '\t'))) i++;
    if (i >= n || i > 3) return 0;
    unichar c = [line characterAtIndex:i];
    if (c != '`' && c != '~') return 0;
    NSUInteger run = 0;
    while (i + run < n && [line characterAtIndex:i + run] == c) run++;
    if (run < 3) return 0;
    if (outChar) *outChar = c;
    if (outInfo) {
        NSString *rest = [line substringFromIndex:i + run];
        *outInfo = [rest stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
    }
    return run;
}

// A table delimiter row. Requires at least one pipe, so a bare "---" — which is
// also frontmatter, a setext underline and a horizontal rule — never matches here.
static BOOL IsTableDelimiter(NSString *line) {
    BOOL pipe = NO, dash = NO;
    for (NSUInteger i = 0; i < line.length; i++) {
        unichar c = [line characterAtIndex:i];
        if (c == '|') pipe = YES;
        else if (c == '-') dash = YES;
        else if (c != ':' && c != ' ' && c != '\t') return NO;
    }
    return pipe && dash;
}

- (void)rescanStructure {
    NSString *s = self.textStorage.string;
    NSUInteger len = s.length;

    NSMutableData *starts = [NSMutableData data];
    NSMutableData *ends = [NSMutableData data];

    NSUInteger idx = 0;
    while (idx <= len) {
        NSUInteger lineStart = 0, lineEnd = 0, contentsEnd = 0;
        [s getLineStart:&lineStart end:&lineEnd contentsEnd:&contentsEnd
               forRange:NSMakeRange(MIN(idx, len), 0)];
        [starts appendBytes:&lineStart length:sizeof(NSUInteger)];
        [ends appendBytes:&contentsEnd length:sizeof(NSUInteger)];
        if (lineEnd == idx) break;      // no progress: end of document
        idx = lineEnd;
        if (idx == len) {
            // A trailing newline means there is one more (empty) line after it,
            // which editors do number.
            if (len > 0 && contentsEnd < lineEnd) {
                [starts appendBytes:&len length:sizeof(NSUInteger)];
                [ends appendBytes:&len length:sizeof(NSUInteger)];
            }
            break;
        }
    }

    NSUInteger n = starts.length / sizeof(NSUInteger);
    NSMutableData *kinds = [NSMutableData dataWithLength:n * sizeof(uint8_t)];
    uint8_t *k = (uint8_t *)kinds.mutableBytes;
    const NSUInteger *st = (const NSUInteger *)starts.bytes;
    const NSUInteger *en = (const NSUInteger *)ends.bytes;

    NSString * (^lineAt)(NSUInteger) = ^NSString *(NSUInteger i) {
        return [s substringWithRange:NSMakeRange(st[i], en[i] - st[i])];
    };

    // Frontmatter only counts when its closing --- actually exists; otherwise
    // typing "---" on the first line of a new note would gray the whole file.
    NSUInteger fmEnd = NSNotFound;
    if (n > 0 && [[lineAt(0) stringByTrimmingCharactersInSet:
                   NSCharacterSet.whitespaceCharacterSet] isEqualToString:@"---"]) {
        for (NSUInteger i = 1; i < n; i++) {
            if ([[lineAt(i) stringByTrimmingCharactersInSet:
                  NSCharacterSet.whitespaceCharacterSet] isEqualToString:@"---"]) {
                fmEnd = i;
                break;
            }
        }
    }

    BOOL inFence = NO;
    unichar fenceChar = 0;
    NSUInteger fenceLen = 0;

    for (NSUInteger i = 0; i < n; i++) {
        NSString *line = lineAt(i);

        if (fmEnd != NSNotFound && i <= fmEnd) {
            k[i] = (i == 0 || i == fmEnd) ? GlyphLineFrontmatterDelim : GlyphLineFrontmatterBody;
            continue;
        }

        unichar c = 0;
        NSString *fInfo = nil;
        NSUInteger run = FenceRun(line, &c, &fInfo);
        if (inFence) {
            // The closer must use the same character, be at least as long, and
            // carry no info string.
            if (run >= fenceLen && c == fenceChar && fInfo.length == 0) {
                k[i] = GlyphLineFenceMarker;
                inFence = NO;
            } else {
                k[i] = GlyphLineFenceBody;
            }
            continue;
        }
        if (run > 0) {
            k[i] = GlyphLineFenceMarker;
            inFence = YES;
            fenceChar = c;
            fenceLen = run;
            continue;
        }

        if (IsTableDelimiter(line)) {
            k[i] = GlyphLineTableDelim;
            if (i > 0 && k[i - 1] == GlyphLinePlain &&
                [lineAt(i - 1) rangeOfString:@"|"].location != NSNotFound) {
                k[i - 1] = GlyphLineTableHeader;
            }
            continue;
        }
        if (i > 0 && (k[i - 1] == GlyphLineTableDelim || k[i - 1] == GlyphLineTableRow) &&
            [line rangeOfString:@"|"].location != NSNotFound && !IsBlankOrWS(line)) {
            k[i] = GlyphLineTableRow;
            continue;
        }

        k[i] = GlyphLinePlain;
    }

    self.starts = starts;
    self.ends = ends;
    self.kinds = kinds;
}

- (NSUInteger)lineIndexForCharacterIndex:(NSUInteger)index {
    NSUInteger n = self.lineCount;
    if (n == 0) return 0;
    const NSUInteger *st = (const NSUInteger *)self.starts.bytes;
    NSUInteger lo = 0, hi = n - 1, best = 0;
    while (lo <= hi) {
        NSUInteger mid = (lo + hi) / 2;
        if (st[mid] <= index) { best = mid; lo = mid + 1; }
        else { if (mid == 0) break; hi = mid - 1; }
    }
    return best;
}

- (NSUInteger)lineNumberForCharacterIndex:(NSUInteger)index {
    return [self lineIndexForCharacterIndex:index] + 1;
}

- (BOOL)isLineStart:(NSUInteger)characterIndex {
    NSUInteger n = self.lineCount;
    if (n == 0) return characterIndex == 0;
    const NSUInteger *st = (const NSUInteger *)self.starts.bytes;
    NSUInteger i = [self lineIndexForCharacterIndex:characterIndex];
    return st[i] == characterIndex;
}

#pragma mark - Bulk replace

- (void)beginBulkReplace { self.bulk = YES; }

- (void)endBulkReplace {
    self.bulk = NO;
    [self rescanStructure];
    if (self.enabled) [self highlightAll];
    else self.stale = YES;
}

- (void)setEnabled:(BOOL)enabled {
    BOOL was = _enabled;
    _enabled = enabled;
    if (enabled && (!was || self.stale)) {
        [self rescanStructure];
        [self highlightAll];
    }
}

#pragma mark - Delegate

- (void)textStorage:(NSTextStorage *)textStorage
 didProcessEditing:(NSTextStorageEditActions)editedMask
             range:(NSRange)editedRange
    changeInLength:(NSInteger)delta {
    // Attribute-only edits fire this too; without the guard our own writes would
    // re-enter in a loop.
    if (!(editedMask & NSTextStorageEditedCharacters)) return;
    if (self.bulk) { self.stale = YES; return; }
    if (!self.enabled) { self.stale = YES; return; }
    if (self.textView.hasMarkedText) return;   // never repaint mid-IME-composition

    NSMutableData *oldKinds = self.kinds;
    NSMutableData *oldStarts = self.starts;
    [self rescanStructure];

    NSUInteger n = self.lineCount;
    if (n == 0) return;

    // A deletion at the very end leaves an empty range whose location equals the
    // length; clamp before asking for the line.
    NSUInteger len = textStorage.length;
    NSUInteger from = MIN(editedRange.location, len ? len - 1 : 0);
    NSUInteger to = MIN(NSMaxRange(editedRange), len ? len - 1 : 0);
    NSUInteger firstLine = [self lineIndexForCharacterIndex:from];
    NSUInteger lastLine = [self lineIndexForCharacterIndex:to];

    // If the line kinds after the edit are unchanged, only the edited lines need
    // repainting. If they differ — a fence or frontmatter delimiter was typed or
    // deleted — everything below has changed meaning and must be repainted.
    BOOL structureShifted = YES;
    NSUInteger oldN = oldKinds.length;
    if (oldN == self.kinds.length && oldStarts.length == self.starts.length) {
        const uint8_t *a = (const uint8_t *)oldKinds.bytes;
        const uint8_t *b = (const uint8_t *)self.kinds.bytes;
        structureShifted = NO;
        for (NSUInteger i = lastLine + 1; i < n; i++) {
            if (a[i] != b[i]) { structureShifted = YES; break; }
        }
    }

    NSUInteger endLine = structureShifted ? n - 1 : MIN(lastLine + 1, n - 1);
    if (firstLine > 0) firstLine -= 1;
    [self highlightLinesFrom:firstLine to:endLine];
}

#pragma mark - Highlighting

- (void)highlightAll {
    if (self.lineCount == 0) return;
    [self highlightLinesFrom:0 to:self.lineCount - 1];
}

- (void)highlightLinesFrom:(NSUInteger)first to:(NSUInteger)last {
    NSTextStorage *ts = self.textStorage;
    if (!ts || self.lineCount == 0) return;
    const NSUInteger *st = (const NSUInteger *)self.starts.bytes;
    const NSUInteger *en = (const NSUInteger *)self.ends.bytes;
    const uint8_t *kd = (const uint8_t *)self.kinds.bytes;
    NSUInteger n = self.lineCount;
    if (first >= n) return;
    if (last >= n) last = n - 1;

    NSString *s = ts.string;
    for (NSUInteger i = first; i <= last; i++) {
        NSRange line = NSMakeRange(st[i], en[i] - st[i]);
        if (NSMaxRange(line) > s.length) continue;
        [self highlightLine:line kind:(GlyphLineKind)kd[i] storage:ts];
    }
}

- (void)highlightLine:(NSRange)line kind:(GlyphLineKind)kind storage:(NSTextStorage *)ts {
    // setAttributes over the line resets it (and restores the paragraph style);
    // every token afterwards uses addAttribute so the style survives.
    [ts setAttributes:GlyphBaseAttributes() range:line];
    if (line.length == 0) return;

    NSString *s = ts.string;
    NSString *text = [s substringWithRange:line];
    NSRange local = NSMakeRange(0, text.length);
    NSUInteger base = line.location;

    void (^color)(NSRange, NSColor *) = ^(NSRange r, NSColor *c) {
        if (r.location == NSNotFound || r.length == 0) return;
        [ts addAttribute:NSForegroundColorAttributeName value:c
                   range:NSMakeRange(base + r.location, r.length)];
    };
    void (^bold)(NSRange) = ^(NSRange r) {
        if (r.location == NSNotFound || r.length == 0) return;
        [ts addAttribute:NSFontAttributeName value:GlyphMonoBoldFont()
                   range:NSMakeRange(base + r.location, r.length)];
    };

    switch (kind) {
        case GlyphLineFrontmatterDelim:
            color(local, GlyphFaint());
            return;
        case GlyphLineFrontmatterBody: {
            static NSRegularExpression *rx;
            if (!rx) rx = RX(@"^([ \\t]*)([^:#\\s][^:]*)(:)([ \\t]*)(.*)$");
            NSTextCheckingResult *m = [rx firstMatchInString:text options:0 range:local];
            if (m) {
                color([m rangeAtIndex:2], GlyphMuted());
                bold([m rangeAtIndex:2]);
                color([m rangeAtIndex:3], GlyphFaint());
                color([m rangeAtIndex:5], GlyphAccent());
            } else {
                color(local, GlyphMuted());
            }
            return;
        }
        case GlyphLineFenceMarker: {
            static NSRegularExpression *rx;
            if (!rx) rx = RX(@"^([ \\t]{0,3})(`{3,}|~{3,})[ \\t]*(\\S*)");
            NSTextCheckingResult *m = [rx firstMatchInString:text options:0 range:local];
            color(local, GlyphFaint());
            if (m && [m rangeAtIndex:3].length) {
                color([m rangeAtIndex:3], GlyphTagColor(@"lang"));
                bold([m rangeAtIndex:3]);
            }
            return;
        }
        case GlyphLineFenceBody:
            color(local, GlyphFG());
            return;
        case GlyphLineTableDelim:
            color(local, GlyphFaint());
            return;
        case GlyphLineTableHeader:
        case GlyphLineTableRow: {
            for (NSUInteger i = 0; i < text.length; i++) {
                if ([text characterAtIndex:i] == '|') color(NSMakeRange(i, 1), GlyphFaint());
            }
            if (kind == GlyphLineTableHeader) {
                // Cell text only; the pipes stay faint because they were set after.
                NSUInteger start = 0;
                for (NSUInteger i = 0; i <= text.length; i++) {
                    BOOL edge = (i == text.length) || ([text characterAtIndex:i] == '|');
                    if (edge) {
                        if (i > start) {
                            NSRange cell = NSMakeRange(start, i - start);
                            color(cell, GlyphMuted());
                            bold(cell);
                        }
                        start = i + 1;
                    }
                }
                for (NSUInteger i = 0; i < text.length; i++) {
                    if ([text characterAtIndex:i] == '|') color(NSMakeRange(i, 1), GlyphFaint());
                }
            } else {
                [self applyInlineRules:text base:base storage:ts];
            }
            return;
        }
        case GlyphLinePlain:
        default:
            break;
    }

    // ---- plain line: block prefixes first, then inline ----
    NSUInteger contentStart = 0;

    // ATX heading. The lookahead after the hashes is what stops "#design" — a
    // tag at the start of a line — from being painted as a heading.
    static NSRegularExpression *rxHead;
    if (!rxHead) rxHead = RX(@"^[ \\t]{0,3}(#{1,6})(?=[ \\t]|$)([ \\t]*)(.*)$");
    NSTextCheckingResult *mh = [rxHead firstMatchInString:text options:0 range:local];
    if (mh) {
        NSUInteger level = [mh rangeAtIndex:1].length;
        NSColor *hc = level == 1 ? GlyphH1() : level == 2 ? GlyphH2()
                    : level == 3 ? GlyphH3() : level == 4 ? GlyphH4() : GlyphMuted();
        color([mh rangeAtIndex:1], GlyphFaint());
        NSRange body = [mh rangeAtIndex:3];
        color(body, hc);
        bold(body);
        [self applyInlineRules:text base:base storage:ts
                       inRange:body skipColor:YES];
        return;
    }

    // Horizontal rule
    static NSRegularExpression *rxHR;
    if (!rxHR) rxHR = RX(@"^[ \\t]{0,3}((\\*[ \\t]*){3,}|(-[ \\t]*){3,}|(_[ \\t]*){3,})$");
    if ([rxHR firstMatchInString:text options:0 range:local]) {
        color(local, GlyphFaint());
        return;
    }

    // Blockquote / callout
    static NSRegularExpression *rxQuote;
    if (!rxQuote) rxQuote = RX(@"^[ \\t]{0,3}((?:>[ \\t]?)+)");
    NSTextCheckingResult *mq = [rxQuote firstMatchInString:text options:0 range:local];
    if (mq) {
        color([mq rangeAtIndex:1], GlyphFaint());
        contentStart = NSMaxRange([mq rangeAtIndex:1]);
        NSRange rest = NSMakeRange(contentStart, text.length - contentStart);
        static NSRegularExpression *rxCallout;
        if (!rxCallout) rxCallout = RX(@"^\\[!(\\w+)\\]([-+])?[ \\t]*(.*)$");
        NSTextCheckingResult *mc = [rxCallout firstMatchInString:text options:0 range:rest];
        if (mc) {
            NSString *type = [text substringWithRange:[mc rangeAtIndex:1]];
            NSColor *cc = GlyphCalloutColor(type);
            color(NSMakeRange(rest.location, NSMaxRange([mc rangeAtIndex:1]) + 1 - rest.location), cc);
            bold(NSMakeRange(rest.location, NSMaxRange([mc rangeAtIndex:1]) + 1 - rest.location));
            if ([mc rangeAtIndex:2].length) color([mc rangeAtIndex:2], GlyphFaint());
            NSRange title = [mc rangeAtIndex:3];
            color(title, cc);
            bold(title);
            return;
        }
        color(rest, GlyphQuote());
        [self applyInlineRules:text base:base storage:ts inRange:rest skipColor:YES];
        return;
    }

    // List marker and task checkbox
    static NSRegularExpression *rxList;
    if (!rxList) rxList = RX(@"^([ \\t]*)([-*+]|\\d+[.)])([ \\t]+)(\\[([ xX])\\][ \\t]+)?");
    NSTextCheckingResult *ml = [rxList firstMatchInString:text options:0 range:local];
    BOOL done = NO;
    if (ml) {
        color([ml rangeAtIndex:2], GlyphFaint());
        contentStart = NSMaxRange(ml.range);
        if ([ml rangeAtIndex:4].length) {
            NSRange box = [ml rangeAtIndex:4];
            color(box, GlyphFaint());
            NSRange mark = [ml rangeAtIndex:5];
            unichar ch = mark.length ? [text characterAtIndex:mark.location] : ' ';
            if (ch == 'x' || ch == 'X') {
                color(mark, GlyphAccent());
                bold(mark);
                done = YES;
            }
        }
    }

    NSRange body = NSMakeRange(contentStart, text.length - contentStart);
    if (done) {
        color(body, GlyphMuted());
        [ts addAttribute:NSStrikethroughStyleAttributeName
                   value:@(NSUnderlineStyleSingle)
                   range:NSMakeRange(base + body.location, body.length)];
        return;
    }
    [self applyInlineRules:text base:base storage:ts inRange:body skipColor:NO];
}

- (void)applyInlineRules:(NSString *)text base:(NSUInteger)base storage:(NSTextStorage *)ts {
    [self applyInlineRules:text base:base storage:ts
                   inRange:NSMakeRange(0, text.length) skipColor:NO];
}

// Ordered rules, first match wins its whole span. One claimed index set, no
// nesting model — the same "first tokenizer wins" behavior simple editors use.
- (void)applyInlineRules:(NSString *)text
                    base:(NSUInteger)base
                 storage:(NSTextStorage *)ts
                 inRange:(NSRange)scope
               skipColor:(BOOL)skipColor {
    if (scope.length == 0 || NSMaxRange(scope) > text.length) return;

    static NSArray<NSRegularExpression *> *rules;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        rules = @[
            RX(@"(`+)([^`]+?)(\\1)"),                                  // 0 inline code
            // One rule for bold, italic and both. Separate ** and * rules would
            // fight: the ** rule's rejected candidate match consumes the opening
            // asterisk that the * rule needs, and the italic silently disappears.
            RX(@"(\\*{1,3})([^*\\s](?:[^*]*[^*\\s])?)(\\1)"),          // 1 * emphasis
            // Underscore emphasis is word-bounded so snake_case survives. Note
            // __init__ IS bold here, which matches what marked.js renders.
            RX(@"(?<![\\p{L}\\p{N}_])(_{1,3})([^_\\s](?:[^_]*[^_\\s])?)(\\1)(?![\\p{L}\\p{N}_])"), // 2 _ emphasis
            RX(@"(~~)([^~]+?)(~~)"),                                   // 3 strike
            RX(@"(==)([^=]+?)(==)"),                                   // 4 highlight
            RX(@"(!?\\[\\[)([^\\]|]+)(\\|[^\\]]+)?(\\]\\])"),          // 5 wikilink
            RX(@"(!\\[)([^\\]]*)(\\]\\()([^)]*)(\\))"),                // 6 image
            RX(@"(\\[)([^\\]]+)(\\]\\()([^)]*)(\\))"),                 // 7 link
            RX(@"(<)((?:https?|mailto):[^>\\s]+)(>)"),                 // 8 autolink
            RX(@"(?<![\\w/])(https?://[^\\s<>\\]\\)]+)"),              // 9 bare url
            RX(@"(?<![\\w&])(#)([A-Za-z_][A-Za-z0-9_/-]*)"),           // 10 tag
        ];
    });

    NSMutableIndexSet *claimed = [NSMutableIndexSet indexSet];
    for (NSUInteger ri = 0; ri < rules.count; ri++) {
        NSRegularExpression *rx = rules[ri];
        NSArray<NSTextCheckingResult *> *ms = [rx matchesInString:text options:0 range:scope];
        for (NSTextCheckingResult *m in ms) {
            NSRange full = m.range;
            if ([claimed containsIndexesInRange:full] ||
                [claimed intersectsIndexesInRange:full]) continue;
            [claimed addIndexesInRange:full];
            [self styleInlineMatch:m rule:ri text:text base:base storage:ts skipColor:skipColor];
        }
    }
}

- (void)styleInlineMatch:(NSTextCheckingResult *)m
                    rule:(NSUInteger)rule
                    text:(NSString *)text
                    base:(NSUInteger)base
                 storage:(NSTextStorage *)ts
               skipColor:(BOOL)skipColor {
    void (^color)(NSRange, NSColor *) = ^(NSRange r, NSColor *c) {
        if (r.location == NSNotFound || r.length == 0) return;
        [ts addAttribute:NSForegroundColorAttributeName value:c
                   range:NSMakeRange(base + r.location, r.length)];
    };
    void (^bg)(NSRange, NSColor *) = ^(NSRange r, NSColor *c) {
        if (r.location == NSNotFound || r.length == 0) return;
        [ts addAttribute:NSBackgroundColorAttributeName value:c
                   range:NSMakeRange(base + r.location, r.length)];
    };
    void (^bold)(NSRange) = ^(NSRange r) {
        if (r.location == NSNotFound || r.length == 0) return;
        [ts addAttribute:NSFontAttributeName value:GlyphMonoBoldFont()
                   range:NSMakeRange(base + r.location, r.length)];
    };
    // Italic is obliqueness, not a font trait: it stays orthogonal to bold so
    // ***both*** composes for free, and glyph advances never change.
    void (^italic)(NSRange) = ^(NSRange r) {
        if (r.location == NSNotFound || r.length == 0) return;
        [ts addAttribute:NSObliquenessAttributeName value:@(0.2)
                   range:NSMakeRange(base + r.location, r.length)];
    };
    void (^strike)(NSRange) = ^(NSRange r) {
        if (r.location == NSNotFound || r.length == 0) return;
        [ts addAttribute:NSStrikethroughStyleAttributeName value:@(NSUnderlineStyleSingle)
                   range:NSMakeRange(base + r.location, r.length)];
    };
    void (^underline)(NSRange) = ^(NSRange r) {
        if (r.location == NSNotFound || r.length == 0) return;
        [ts addAttribute:NSUnderlineStyleAttributeName value:@(NSUnderlineStyleSingle)
                   range:NSMakeRange(base + r.location, r.length)];
    };

    switch (rule) {
        case 0:  // `code`
            color([m rangeAtIndex:1], GlyphFaint());
            color([m rangeAtIndex:3], GlyphFaint());
            if (!skipColor) color([m rangeAtIndex:2], GlyphFG());
            bg(m.range, GlyphCodeBG());
            break;
        case 1: case 2: {  // emphasis: marker length decides bold / italic / both
            color([m rangeAtIndex:1], GlyphFaint());
            color([m rangeAtIndex:3], GlyphFaint());
            NSRange body = [m rangeAtIndex:2];
            NSUInteger n = [m rangeAtIndex:1].length;
            // Bold rides on the font and italic on obliqueness, so they are
            // orthogonal and ***both*** composes without any trait merging.
            if (n == 2 || n == 3) bold(body);
            if (n == 1 || n == 3) italic(body);
            break;
        }
        case 3:  // ~~strike~~
            color([m rangeAtIndex:1], GlyphFaint());
            color([m rangeAtIndex:3], GlyphFaint());
            if (!skipColor) color([m rangeAtIndex:2], GlyphMuted());
            strike([m rangeAtIndex:2]);
            break;
        case 4:  // ==highlight==
            color([m rangeAtIndex:1], GlyphFaint());
            color([m rangeAtIndex:3], GlyphFaint());
            bg([m rangeAtIndex:2], GlyphHighlightBG());
            break;
        case 5:  // [[wikilink]] or [[target|alias]]
            color([m rangeAtIndex:1], GlyphFaint());
            color([m rangeAtIndex:4], GlyphFaint());
            if ([m rangeAtIndex:3].length) {
                color([m rangeAtIndex:2], GlyphMuted());          // target, not displayed
                NSRange alias = [m rangeAtIndex:3];
                color(NSMakeRange(alias.location, 1), GlyphFaint());  // the pipe
                color(NSMakeRange(alias.location + 1, alias.length - 1), GlyphLink());
            } else {
                color([m rangeAtIndex:2], GlyphLink());
            }
            break;
        case 6:  // ![alt](path)
            color([m rangeAtIndex:1], GlyphFaint());
            color([m rangeAtIndex:2], GlyphMuted());
            color([m rangeAtIndex:3], GlyphFaint());
            color([m rangeAtIndex:4], GlyphMuted());
            color([m rangeAtIndex:5], GlyphFaint());
            break;
        case 7:  // [label](url)
            color([m rangeAtIndex:1], GlyphFaint());
            color([m rangeAtIndex:2], GlyphLink());
            underline([m rangeAtIndex:2]);
            color([m rangeAtIndex:3], GlyphFaint());
            color([m rangeAtIndex:4], GlyphMuted());
            color([m rangeAtIndex:5], GlyphFaint());
            break;
        case 8: // <https://...>
            color([m rangeAtIndex:1], GlyphFaint());
            color([m rangeAtIndex:2], GlyphLink());
            underline([m rangeAtIndex:2]);
            color([m rangeAtIndex:3], GlyphFaint());
            break;
        case 9: // bare url
            color([m rangeAtIndex:1], GlyphLink());
            underline([m rangeAtIndex:1]);
            break;
        case 10: { // #tag
            NSString *tag = [text substringWithRange:[m rangeAtIndex:2]];
            NSColor *c = GlyphTagColor(tag);
            color(m.range, c);
            break;
        }
        default:
            break;
    }
}

@end
