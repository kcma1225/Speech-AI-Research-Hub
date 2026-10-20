export type BuiltinDeck={slug:string;title:string;src:string;label:string;note:string};

// Quarto decks rendered into slides/_site and served by nginx at src.
export const builtinDecks:BuiltinDeck[]=[
  {slug:"interspeech_2019_zhao",title:"Shallow-Fusion End-to-End Contextual Biasing",src:"/interspeech_2019_zhao/",label:"論文報告",note:"Zhao et al. · Interspeech 2019"},
  {slug:"meet1",title:"Meet 1",src:"/meet1/",label:"範例",note:"內建 Quarto reveal.js 簡報"},
];
