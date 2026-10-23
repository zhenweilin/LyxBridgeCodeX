// Read the native representation of an explicit browser paste. Never write to
// the general pasteboard, poll it, or return any unrelated clipboard format.
#import <AppKit/AppKit.h>

static const NSUInteger MaxBytes = 512 * 1024;
static NSString * const LyXType = @"com.trolltech.anymime.application--x-lyx";

static NSString *normalized(NSString *value) {
    return [[[value stringByReplacingOccurrencesOfString:@"\r\n" withString:@"\n"]
        stringByReplacingOccurrencesOfString:@"\r" withString:@"\n"] precomposedStringWithCanonicalMapping];
}

static NSDictionary *readLyX(NSPasteboard *board, NSString *expected) {
    NSInteger revision = board.changeCount;
    NSArray<NSPasteboardItem *> *items = board.pasteboardItems;
    if (items.count != 1) return @{@"status": @"unavailable"};
    NSPasteboardItem *item = items.firstObject;
    NSString *type = [item.types containsObject:LyXType] ? LyXType
        : [item.types containsObject:@"application/x-lyx"] ? @"application/x-lyx" : nil;
    if (!type) return @{@"status": @"unavailable"};
    NSString *plain = [board stringForType:NSPasteboardTypeString];
    if (!plain) {
        NSData *utf16 = [item dataForType:@"public.utf16-plain-text"];
        if (utf16) plain = [[NSString alloc] initWithData:utf16 encoding:NSUTF16StringEncoding];
    }
    if (!plain || ![normalized(plain) isEqualToString:normalized(expected)])
        return @{@"status": @"mismatch"};
    NSData *data = [item dataForType:type];
    if (board.changeCount != revision) return @{@"status": @"mismatch"};
    if (!data.length || data.length > MaxBytes) return @{@"status": @"invalid"};
    // LyX may contain legacy-encoded bytes: preserve them, never round-trip
    // native MIME through NSString or the browser's UTF-8 text decoder.
    NSData *header = [@"\\lyxformat " dataUsingEncoding:NSASCIIStringEncoding];
    NSData *end = [@"\\end_document" dataUsingEncoding:NSASCIIStringEncoding];
    if ([data rangeOfData:header options:0 range:NSMakeRange(0, MIN(data.length, 256))].location == NSNotFound
        || [data rangeOfData:end options:0 range:NSMakeRange(0, data.length)].location == NSNotFound)
        return @{@"status": @"invalid"};
    return @{@"status": @"matched", @"lyx": [data base64EncodedStringWithOptions:0]};
}

static int selfTest(void) {
    // An isolated, uniquely named pasteboard; the user's clipboard is untouched.
    NSPasteboard *board = [NSPasteboard pasteboardWithUniqueName];
    NSData *lyx = [@"#LyX test\n\\lyxformat 620\n\\begin_document\n\\end_document\n" dataUsingEncoding:NSUTF8StringEncoding];
    NSArray *types = @[LyXType, NSPasteboardTypeString];
    [board declareTypes:types owner:nil];
    [board setData:lyx forType:LyXType];
    [board setString:@"中文 e\u0301 x^{2}\r\nline" forType:NSPasteboardTypeString];
    NSDictionary *match = readLyX(board, @"中文 é x^{2}\nline");
    BOOL ok = [match[@"status"] isEqual:@"matched"]
        && [match[@"lyx"] isEqual:[lyx base64EncodedStringWithOptions:0]]
        && [readLyX(board, @"unrelated selection")[@"status"] isEqual:@"mismatch"];
    [board setData:[NSData dataWithBytes:"bad" length:3] forType:LyXType];
    ok &= [readLyX(board, @"中文 é x^{2}\nline")[@"status"] isEqual:@"invalid"];
    [board setData:[NSMutableData dataWithLength:MaxBytes + 1] forType:LyXType];
    ok &= [readLyX(board, @"中文 é x^{2}\nline")[@"status"] isEqual:@"invalid"];
    [board declareTypes:@[NSPasteboardTypeString] owner:nil];
    [board setString:@"ordinary text" forType:NSPasteboardTypeString];
    ok &= [readLyX(board, @"ordinary text")[@"status"] isEqual:@"unavailable"];
    [board releaseGlobally];
    puts(ok ? "Private-pasteboard tests passed" : "Private-pasteboard tests failed");
    return ok ? 0 : 1;
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc == 2 && strcmp(argv[1], "--self-test") == 0) return selfTest();
        if (argc != 1) return 2;
        NSData *input = [[NSFileHandle fileHandleWithStandardInput] readDataToEndOfFile];
        if (input.length > 1024 * 1024) return 2;
        id request = [NSJSONSerialization JSONObjectWithData:input options:0 error:nil];
        if (![request isKindOfClass:NSDictionary.class] || ![request[@"text"] isKindOfClass:NSString.class]) return 2;
        NSString *text = request[@"text"];
        if (!text.length || [text lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > MaxBytes) return 2;
        NSDictionary *result = readLyX(NSPasteboard.generalPasteboard, text);
        NSData *output = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
        [[NSFileHandle fileHandleWithStandardOutput] writeData:output];
    }
    return 0;
}
