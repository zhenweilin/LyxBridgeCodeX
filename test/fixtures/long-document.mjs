// Synthetic prose only: never populate performance fixtures from a user paper.
export function longDocument(source,count=3000){
  const paragraphs=Array.from({length:count},(_,i)=>`\\begin_layout Standard\nParagraph ${i+1}. ${'A synthetic long document measures scrolling and selection without using private content. '.repeat(5)}\n\\end_layout\n`).join('\n');
  return source.replace(/\\begin_body[\s\S]*\\end_body/,`\\begin_body\n${paragraphs}\n\\end_body`);
}
