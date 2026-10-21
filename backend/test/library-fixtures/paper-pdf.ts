/** A small 3-page "paper" (numbered sections, an equation line, references) for the reading tools. */
import { makePdf } from "./helpers.js";

export const PAPER_PDF = makePdf([], {
  pages: [
    [
      ["Learning Speech Emotion With Tiny Transformers", 16, 740],
      ["Ada Author, Bob Builder", 11, 715],
      ["Abstract", 12, 690],
      ["We propose a tiny transformer for speech emotion recognition.", 10, 672],
      ["1 Introduction", 12, 640],
      ["Emotion recognition from speech is hard because labels are noisy.", 10, 622],
      ["2 shows that the task is popular.", 10, 606],
    ],
    [
      ["2 Related Work", 12, 740],
      ["Prior work used recurrent networks.", 10, 722],
      ["2.1 Self-Supervised Models", 12, 700],
      ["Wav2vec features are strong baselines for many speech tasks.", 10, 682],
      ["3 Method", 12, 650],
      ["The loss is L = -sum y log p (1)", 10, 632],
      ["where y is the label and p the predicted probability.", 10, 616],
    ],
    [
      ["3.1 Training", 12, 740],
      ["We train for 10 epochs with Adam.", 10, 722],
      ["4 Experiments", 12, 700],
      ["Our model reaches 71.2% unweighted accuracy on IEMOCAP.", 10, 682],
      ["5 Conclusion", 12, 650],
      ["Tiny transformers work well.", 10, 632],
      ["References", 12, 600],
      ["[1] A. Baevski et al. wav2vec 2.0. NeurIPS 2020.", 9, 582],
    ],
  ],
});
