// SPDX-License-Identifier: GPL-2.0-or-later
// A literal-label index, not a TeX interpreter. Offsets refer to the input.
#ifndef CODEX_LATEX_LABELS_H
#define CODEX_LATEX_LABELS_H
#include <string>
#include <vector>

namespace lyx { namespace codex {
template<class String> struct LatexLabel {
    String name;
    std::size_t offset;
};

template<class String> class LabelScanner {
    String const & text;
    std::size_t pos = 0;
    bool letter(typename String::value_type c) const
        { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '@'; }
    bool space(typename String::value_type c) const
        { return c == ' ' || c == '\t' || c == '\r' || c == '\n'; }
    void comment() { while (pos < text.size() && text[pos] != '\n') ++pos; }
    void whitespace() {
        while (pos < text.size()) {
            if (text[pos] == '%') comment();
            else if (space(text[pos])) ++pos;
            else break;
        }
    }
    std::string command() {
        ++pos;
        std::string name;
        if (pos < text.size() && !letter(text[pos])) name += char(text[pos++]);
        else while (pos < text.size() && letter(text[pos])) name += char(text[pos++]);
        return name;
    }
    // Skip a balanced argument, respecting control symbols and comments.
    bool group(typename String::value_type open = '{', typename String::value_type close = '}') {
        whitespace();
        if (pos == text.size() || text[pos] != open) return false;
        int depth = 1; ++pos;
        while (pos < text.size() && depth) {
            if (text[pos] == '%') comment();
            else if (text[pos] == '\\') command();
            else {
                if (text[pos] == open) ++depth;
                if (text[pos] == close) --depth;
                ++pos;
            }
        }
        return depth == 0;
    }
    String literal() {
        whitespace();
        if (pos == text.size() || text[pos] != '{') return {};
        ++pos; String name; bool valid = true;
        while (pos < text.size() && text[pos] != '}') {
            auto c = text[pos];
            if (c == '%') { comment(); if (pos < text.size()) ++pos; continue; }
            if (c == '{') { valid = false; group(); continue; }
            if (c == '\\') { valid = false; command(); continue; }
            if (space(c) || c == '#' || c == '~' || c == '^' || c == '&' || c == '$' || c == ',') valid = false;
            name += c; ++pos;
        }
        if (pos == text.size()) return {};
        ++pos;
        return valid ? name : String();
    }
    String ascii(std::string const & s) { return String(s.begin(), s.end()); }
public:
    explicit LabelScanner(String const & value) : text(value) {}
    std::vector<LatexLabel<String>> scan() {
        std::vector<LatexLabel<String>> result;
        while (pos < text.size()) {
            if (text[pos] == '%') { comment(); continue; }
            if (text[pos] != '\\') { ++pos; continue; }
            auto const offset = pos;
            std::string const cmd = command();
            if (cmd == "label") {
                auto name = literal();
                if (!name.empty()) result.push_back({name, offset});
            } else if (cmd == "verb" || cmd == "lstinline") {
                if (pos < text.size() && text[pos] == '*') ++pos;
                if (cmd == "lstinline") group('[', ']');
                if (pos < text.size() && !space(text[pos])) {
                    auto const delimiter = text[pos++];
                    while (pos < text.size() && text[pos] != delimiter && text[pos] != '\n') ++pos;
                    if (pos < text.size() && text[pos] == delimiter) ++pos;
                }
            } else if (cmd == "string" || cmd == "noexpand") {
                whitespace();
                if (pos < text.size()) { if (text[pos] == '\\') command(); else ++pos; }
            } else if (cmd == "detokenize") {
                group();
            } else if (cmd == "begin") {
                auto const env = literal();
                if (env == ascii("verbatim") || env == ascii("verbatim*") || env == ascii("Verbatim")
                    || env == ascii("lstlisting") || env == ascii("minted") || env == ascii("comment")) {
                    auto const end = text.find(ascii("\\end{") + env + ascii("}"), pos);
                    pos = end == String::npos ? text.size() : end + env.size() + 6;
                }
            } else if (cmd == "newcommand" || cmd == "renewcommand" || cmd == "providecommand"
                || cmd == "DeclareRobustCommand" || cmd == "newenvironment" || cmd == "renewenvironment"
                || cmd == "NewDocumentCommand" || cmd == "RenewDocumentCommand" || cmd == "ProvideDocumentCommand"
                || cmd == "DeclareDocumentCommand") {
                if (pos < text.size() && text[pos] == '*') ++pos;
                whitespace();
                if (pos < text.size() && text[pos] == '\\') command(); else group();
                if (cmd.find("DocumentCommand") != std::string::npos) group();
                else { group('[', ']'); group('[', ']'); }
                group();
                if (cmd.find("environment") != std::string::npos) group();
            } else if (cmd == "def" || cmd == "gdef" || cmd == "edef" || cmd == "xdef") {
                while (pos < text.size() && text[pos] != '{') {
                    if (text[pos] == '%') comment();
                    else if (text[pos] == '\\') command();
                    else ++pos;
                }
                group();
            } else if (cmd == "iffalse") {
                int depth = 1;
                while (pos < text.size() && depth) {
                    if (text[pos] == '%') comment();
                    else if (text[pos] == '\\') {
                        auto const next = command();
                        if (next.compare(0, 2, "if") == 0) ++depth;
                        else if (next == "fi") --depth;
                        else if (next == "else" && depth == 1) break;
                    } else ++pos;
                }
            }
        }
        return result;
    }
};
template<class String> std::vector<LatexLabel<String>> latexLabels(String const & text)
    { return LabelScanner<String>(text).scan(); }
}}
#endif
