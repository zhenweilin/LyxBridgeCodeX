// SPDX-License-Identifier: GPL-2.0-or-later
#include "CodexLatexLabels.h"
#include <cassert>
#include <iostream>

int main() {
    std::string const source = R"tex(
\State $x\gets x+1$\label{line:update}
% \label{comment}
\\label{escaped}
\verb|\label{verb}| \verb*+\label{verb-star}+
\begin{verbatim}\label{verbatim}\end{verbatim}
\begin{lstlisting}\label{listing}\end{lstlisting}
\newcommand{\test}[1]{\label{#1}\label{definition}}
\newcommand\test{\label{definition2}}
\NewDocumentCommand{\test}{m}{\label{definition3}}
\newenvironment{test}{\label{begin-definition}}{\label{end-definition}}
\def\test#1{\label{definition4}}
\detokenize{\label{detokenized}} \string\label{string}
\iffalse \label{false} \iftrue\label{nested}\fi \else \label{else}\fi
\label % comment between command and argument
{line:split}
\label{line:com% inline comment
ment}
\label{\dynamic} \label{#1} \label{with space} \label{nested{brace}}
\labelfoo{wrong-command} \label{line:update}
\label{unfinished
)tex";
    auto const labels = lyx::codex::latexLabels(source);
    std::vector<std::string> names;
    for (auto const & label : labels) {
        names.push_back(label.name);
        assert(source.substr(label.offset, 6) == "\\label");
    }
    assert((names == std::vector<std::string>{"line:update","else","line:split","line:comment","line:update"}));
    auto unicode = lyx::codex::latexLabels(std::u32string(U"😀 \\label{行:更新}"));
    assert(unicode.size() == 1 && unicode[0].offset == 2 && unicode[0].name == U"行:更新");
    assert(lyx::codex::latexLabels(std::string("\\label{} \\label")).empty());
    std::cout << "Literal LaTeX label parser checks passed\n";
}
