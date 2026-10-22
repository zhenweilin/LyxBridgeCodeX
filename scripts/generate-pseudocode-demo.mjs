import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const demo=resolve(root,'demo'),guide=resolve(demo,'pseudocode-guide');
await mkdir(guide,{recursive:true});
const examples=[
  {title:'Nested While and For loops',label:'loops',code:String.raw`\Require $x_0\in\mathbb{R}^n$, $K>0$, $\alpha>0$, $\varepsilon>0$
\State $x\gets x_0$, $k\gets 0$
\While{$\|g(x)\|>\varepsilon$ and $k<K$}
  \For{$i=1,\ldots,n$}
    \State $x_i\gets x_i-\alpha g_i(x)$
  \EndFor
  \State $k\gets k+1$
\EndWhile
\State \Return $x$`},
  {title:'If, ElseIf, Else and Return',label:'branches',code:String.raw`\Function{Clip}{$x,\ell,u$}
  \If{$x<\ell$}
    \State \Return $\ell$ \Comment{Lower bound}
  \ElsIf{$x>u$}
    \State \Return $u$ \Comment{Upper bound}
  \Else
    \State \Return $x$
  \EndIf
\EndFunction
\State $z\gets\Call{Clip}{y,0,1}$`},
  {title:'Repeat, Procedure and ForAll',label:'repeat',code:String.raw`\Procedure{Refine}{$x_0,\varepsilon$}
  \State $x\gets x_0$
  \Repeat
    \State $x_{\mathrm{old}}\gets x$
    \State $x\gets T(x)$ \Comment{One iteration}
  \Until{$\|x-x_{\mathrm{old}}\|\leq\varepsilon$}
  \State \Return $x$
\EndProcedure
\ForAll{$x_0\in S$}
  \State \Call{Refine}{$x_0,\varepsilon$}
\EndFor`}
];
const minimal=String.raw`\begin{algorithmic}[1]
\State $k\gets 0$
\While{$k<3$}
  \State $k\gets k+1$
\EndWhile
\end{algorithmic}`;
const standalone=String.raw`\documentclass{article}
\usepackage{amsmath,amssymb}
\usepackage{algorithm}
\usepackage[noEnd=false]{algpseudocodex}
\begin{document}
\begin{algorithm}
\caption{A small counter}\label{alg:counter}
\begin{algorithmic}[1]
\State $k\gets 0$
\While{$k<3$}
  \State $k\gets k+1$
\EndWhile
\State \Return $k$
\end{algorithmic}
\end{algorithm}
See Algorithm~\ref{alg:counter}.
\end{document}`;

const preamble=String.raw`\documentclass[11pt,letterpaper]{article}
\usepackage[T1]{fontenc}
\usepackage{lmodern,microtype}
\usepackage[margin=0.78in]{geometry}
\usepackage{amsmath,amssymb,algorithm}
\usepackage[noEnd=false]{algpseudocodex}
\usepackage{xcolor,listings,booktabs,array,enumitem,fancyhdr}
\usepackage[colorlinks=true,linkcolor=blue!45!black,urlcolor=blue!45!black]{hyperref}
\definecolor{ink}{HTML}{18334A}
\definecolor{accent}{HTML}{B35C32}
\definecolor{paper}{HTML}{F3F5F7}
\lstset{language=[LaTeX]TeX,basicstyle=\ttfamily\small,
  keywordstyle=\color{ink},commentstyle=\color{gray},
  backgroundcolor=\color{paper},frame=single,rulecolor=\color{black!12},
  framerule=0.4pt,framesep=8pt,breaklines=true,columns=fullflexible,
  keepspaces=true,showstringspaces=false,aboveskip=9pt,belowskip=10pt}
\setlength{\parindent}{0pt}
\setlength{\parskip}{6pt}
\setlist{nosep,leftmargin=*}
\pagestyle{fancy}\fancyhf{}
\fancyhead[L]{\small\sffamily\color{ink}LyxBridgeCodeX}
\fancyhead[R]{\small\sffamily LaTeX pseudocode}
\fancyfoot[L]{\small\color{gray}Feature guide and working examples}
\fancyfoot[R]{\thepage}
\setlength{\headheight}{14pt}
\newcommand{\eyebrow}[1]{{\small\sffamily\bfseries\color{accent}#1}\par}
\newcommand{\pagetitle}[2]{\eyebrow{#1}{\LARGE\sffamily\bfseries\color{ink}#2\par}\vspace{6pt}}
\newcommand{\labelhead}[1]{\par\vspace{4pt}{\sffamily\bfseries\color{ink}#1\par}}
\begin{document}
`;
let tex=preamble+String.raw`
\pagetitle{NEW FEATURE / QUICK START}{LaTeX pseudocode in LyX}
Write actual LaTeX commands. LyX shows their compiled result when you leave the source block, and exports the same code to PDF. Line numbers, keywords, indentation and block guides are supplied by \texttt{algpseudocodex}.

\labelhead{Try it in the editor}
\begin{enumerate}
\item Open \texttt{demo/pseudocode-demo.lyx} in the embedded LyX editor.
\item Put the cursor in a text paragraph, or inside an Algorithm float after its caption.
\item Open the environment dropdown (env), type \texttt{LaTeX Pseudocode}, and press Enter. An editable LaTeX block appears.
\item Replace the example commands with your own. Keep one matching pair of \texttt{algorithmic} begin/end commands and the enclosing \texttt{minipage} wrapper.
\item Click in a paragraph outside the block, or choose \texttt{Render LaTeX Pseudocode} from env. The preview appears after compilation.
\item Click the preview to return to the source, then click inside its red LaTeX box to edit. Use ordinary LyX Save and Undo.
\end{enumerate}

\labelhead{A first working example}
The following is the algorithmic part of a block. The env command supplies its wrapper automatically.
\begin{lstlisting}
`+minimal+String.raw`
\end{lstlisting}
\labelhead{Rendered from exactly that source}
`+minimal+String.raw`

\vfill
\textbf{What changes:} a block is real LaTeX inside a native LyX Preview inset. Source indentation is optional; the paired commands define the displayed nesting. Existing Enumerate algorithms are not converted automatically.
\newpage
`;
for(let i=0;i<examples.length;i++){
 const e=examples[i];
 tex+=String.raw`\pagetitle{EXAMPLE `+(i+1)+String.raw` / SOURCE AND OUTPUT}{`+e.title+String.raw`}
`+[
String.raw`Choose \texttt{LaTeX While} or \texttt{LaTeX For} from env to insert a complete, paired block. Inside an existing source block, put the caret before the enclosing end command before adding the inner loop.`,
String.raw`Use \texttt{LaTeX If / Else} and \texttt{LaTeX Function} as starting points. Add \verb|\ElsIf| in the source for additional branches. The exact spelling is \texttt{ElsIf}.`,
String.raw`Choose \texttt{LaTeX Repeat / Until}, \texttt{LaTeX Procedure}, or \texttt{LaTeX For All}.

Repeat closes with \verb|\Until{condition}|. ForAll closes with \verb|\EndFor|.`
 ][i]+String.raw`
\labelhead{Copy these lines inside the algorithmic environment}
\begin{lstlisting}
`+e.code+String.raw`
\end{lstlisting}
\labelhead{Rendered result}
\begin{algorithmic}[1]
`+e.code+String.raw`
\end{algorithmic}
\vfill
`+[
String.raw`\textbf{Nesting rule:} close inner blocks first. Each \verb|\State| creates a numbered statement. \verb|\Require| and \verb|\Ensure| create input/output labels without line numbers.`,
String.raw`\textbf{Return rule:} write \verb|\State \Return ...| for a numbered return line. \verb|\Comment{...}| attaches an explanation to the current statement.`,
String.raw`\textbf{Math rule:} put variables and expressions in \texttt{\$...\$}. Ordinary prose stays outside math mode. The examples illustrate notation and control flow, not a convergence guarantee.`
 ][i]+String.raw`
\newpage
`;
}
tex+=String.raw`
\pagetitle{PORTABILITY / ORDINARY LATEX}{Use the same code outside LyX}
The file \texttt{demo/pseudocode-demo.tex} is a complete standalone LaTeX document containing the three examples. Compile it with pdfLaTeX. No Codex-specific command or custom document class is required.
\labelhead{A complete minimal document}
\begin{lstlisting}
`+standalone+String.raw`
\end{lstlisting}
\labelhead{Captions, labels and macros}
In LyX, insert a native \textbf{Algorithm float}, give it a caption and label, then place the pseudocode Preview block in the float body. Keep the float itself outside the Preview block. In standalone LaTeX, use the \texttt{algorithm} environment shown above.

Use your own math macros in the source. Preamble definitions are available to both preview and export; this feature also carries native LyX math-macro definitions into the raw-code preview. Keep each definition before the algorithm that uses it. For raw-code math, explicitly load packages such as \texttt{amsmath} and \texttt{amssymb} in Document Settings; LyX cannot infer all package requirements from raw LaTeX.

\textbf{Package settings:} a new document receives \verb|\usepackage[noEnd=false]{algpseudocodex}| when needed. An existing \texttt{algpseudocodex} or \texttt{algpseudocode} setup is retained. The default \texttt{algpseudocodex} setting hides end statements; \texttt{noEnd=false} shows them, as in this guide.
\newpage
\pagetitle{REFERENCE / EDITING AND RECOVERY}{Working with the new environments}
\labelhead{Entries in the env dropdown}
\renewcommand{\arraystretch}{1.16}
\begin{tabular}{@{}p{0.43\linewidth}p{0.52\linewidth}@{}}
\toprule
\textbf{Entry} & \textbf{What it inserts or does}\\
\midrule
LaTeX Pseudocode & Creates a complete editable preview block.\\
LaTeX While / For / For All & Inserts paired loop commands.\\
LaTeX If / Else & Inserts a conditional with both branches.\\
LaTeX Repeat / Until & Inserts a loop with its final condition.\\
LaTeX Function / Procedure & Inserts a named block and its end.\\
LaTeX State / Return / Comment & Inserts a statement, return, or comment.\\
LaTeX Input / Output & Inserts Require and Ensure declarations.\\
Render LaTeX Pseudocode & Leaves the source and refreshes its preview.\\
\bottomrule
\end{tabular}

Outside a source block, a template creates a new wrapped preview. Inside the raw LaTeX source, it inserts commands at the caret without adding another wrapper. A template is editable example code: replace its conditions, variable names and statements. Clear a selection before inserting a template.

\labelhead{From an Enumerate algorithm}
Copy the mathematical content into \verb|\State| commands. Replace typed While/For/If keywords with the paired LaTeX commands, and remove manual \verb|\tab| or spacing macros. Preserve the algorithm's caption and label. Check branch boundaries while converting; the editor does not infer them from whitespace.

\labelhead{If a preview does not appear}
\begin{itemize}
\item First click \emph{outside} the preview block. While the cursor is inside, LyX intentionally shows editable source.
\item Check unmatched braces, missing math delimiters, and pairs such as While/EndWhile and If/EndIf. Keep only one algorithmic wrapper.
\item Verify the TeX installation contains \texttt{algpseudocodex} (or \texttt{algpseudocode}) and the preview tools. An invalid block remains available as source for correction.
\item Use the same package options and macros in preview and final output. Font scale, available width, page breaks and final cross-reference numbers can still differ; preview is not a full-document PDF viewer.
\end{itemize}

\labelhead{Files supplied with this demo}
\begin{itemize}
\item \texttt{pseudocode-guide.pdf}: this guide.
\item \texttt{pseudocode-demo.lyx}: editable live examples.
\item \texttt{pseudocode-demo.tex}: standalone examples.
\item \texttt{pseudocode-guide/main.tex}: guide source.
\end{itemize}
\end{document}
`;
await writeFile(resolve(guide,'main.tex'),tex);
let standaloneExamples=String.raw`\documentclass{article}
\usepackage[T1]{fontenc}
\usepackage{lmodern,amsmath,amssymb,algorithm}
\usepackage[noEnd=false]{algpseudocodex}
\usepackage[margin=1in]{geometry}
\title{LaTeX Pseudocode: Working Examples}
\author{LyxBridgeCodeX}
\date{}
\begin{document}
\maketitle
The commands below are the same commands used in the editable LyX preview blocks.
`;
for(const e of examples)standaloneExamples+='\n\\begin{algorithm}[h]\n\\caption{'+e.title+'}\\label{alg:'+e.label+'}\n\\begin{algorithmic}[1]\n'+e.code+'\n\\end{algorithmic}\n\\end{algorithm}\n';
standaloneExamples+='\n\\end{document}\n';
await writeFile(resolve(demo,'pseudocode-demo.tex'),standaloneExamples);
const para=(style,text)=>`\\begin_layout ${style}\n${text}\n\\end_layout\n\n`;
const raw=latex=>'\\begin_inset ERT\nstatus open\n\n'+latex.split('\n').map(line=>para('Plain Layout',line.replaceAll('\\','\n\\backslash\n'))).join('')+'\\end_inset\n';
let lyx=String.raw`#LyX 2.4 created this file. For more info see https://www.lyx.org/
\lyxformat 620
\begin_document
\begin_header
\save_transient_properties true
\origin unavailable
\textclass article
\begin_preamble
\usepackage[noEnd=false]{algpseudocodex}
\end_preamble
\use_default_options true
\language english
\inputencoding utf8
\fontencoding auto
\use_non_tex_fonts false
\use_package amsmath 2
\use_package amssymb 2
\secnumdepth 3
\tocdepth 3
\tracking_changes false
\output_changes false
\end_header
\begin_body
`;
lyx+=para('Title','LaTeX Pseudocode: Live Examples')+para('Author','LyxBridgeCodeX');
lyx+=para('Standard','Click a rendered algorithm to reveal its LaTeX source. Click inside the red source box to edit. Click outside the block, or choose Render LaTeX Pseudocode from env, to compile the preview again.');
lyx+=para('Standard','To create a new block, choose LaTeX Pseudocode from env. While editing its source, use LaTeX While, LaTeX For, or LaTeX If / Else to insert templates at the caret. Replace their example expressions with your own.');
for(const e of examples){
 lyx+=para('Section',e.title);
 lyx+=para('Standard','The numbered statements, keywords and indentation below are rendered by LaTeX. The full source is editable inside the preview block.');
 const caption='\\begin_inset Caption Standard\n\n'+para('Plain Layout',e.title+'\n\\begin_inset CommandInset label\nLatexCommand label\nname "alg:'+e.label+'"\n\n\\end_inset\n')+'\\end_inset\n';
 const preview='\\begin_inset Preview\n\n'+para('Plain Layout',raw('\\begin{minipage}{\\linewidth}\n\\begin{algorithmic}[1]\n'+e.code+'\n\\end{algorithmic}\n\\end{minipage}'))+'\\end_inset\n';
 lyx+=para('Standard','\\begin_inset Float algorithm\nplacement h\nalignment document\nwide false\nsideways false\nstatus open\n\n'+para('Plain Layout',caption)+para('Plain Layout',preview)+'\\end_inset\n');
 lyx+=para('Standard','Click here to leave the source block and display the compiled preview.');
}
lyx+='\\end_body\n\\end_document\n';
await writeFile(resolve(demo,'pseudocode-demo.lyx'),lyx);
console.log('Generated pseudocode guide source and matching LyX/LaTeX examples.');
