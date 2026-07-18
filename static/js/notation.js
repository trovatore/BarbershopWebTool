/* notation.js Serial: #029 */
const { Renderer, Stave, StaveNote, Voice, Formatter, Accidental, StaveConnector } = Vex.Flow;
import { ACC_TO_STR } from './spelling.js';

export const SERIAL = "#029";

export function drawChord(divId, chordState) {
    const div = document.getElementById(divId);
    div.innerHTML = "";
    const renderer = new Renderer(div, Renderer.Backends.SVG);
    renderer.resize(740, 320);
    const context = renderer.getContext();
    
    const topStave = new Stave(100, 50, 500).addClef("treble", "default", "8vb").setContext(context).draw();
    const botStave = new Stave(100, 180, 500).addClef("bass").setContext(context).draw();
    new StaveConnector(topStave, botStave).setType(StaveConnector.type.BRACE).setContext(context).draw();

    const makeNote = (noteObj, stem, clef, forceNatural, isUnison, xShift = 0) => {
        let o = (clef === 'treble') ? noteObj.oct + 1 : noteObj.oct;
        const vn = new StaveNote({ keys: [`${noteObj.step}/${o}`], duration: "q", stem_direction: stem, clef: clef });
        
        let accStr = null;
        if (noteObj.acc !== 0 && !isUnison) {
            accStr = ACC_TO_STR[noteObj.acc].replace('x', '##');
        } else if (noteObj.acc === 0 && forceNatural) {
            accStr = "n";
        }
        
        if (accStr) {
            vn.addModifier(new Accidental(accStr), 0);
        }

        if (xShift !== 0) {
            vn.setXShift(xShift);
        }

        return vn;
    };

    const getLogic = (vUp, vDown) => {
        const isUnison = (vUp.step === vDown.step && vUp.acc === vDown.acc && vUp.oct === vDown.oct);
        const isFalse = (vUp.step === vDown.step && vUp.oct === vDown.oct && vUp.acc !== vDown.acc);
        const upNat = (vUp.acc === 0 && vDown.acc !== 0 && vUp.step === vDown.step && vUp.oct === vDown.oct);
        const downNat = (vDown.acc === 0 && vUp.acc !== 0 && vUp.step === vDown.step && vDown.oct === vUp.oct);
        return { isUnison, isFalse, upNat, downNat };
    };

    const tL = getLogic(chordState[3], chordState[2]);
    const bL = getLogic(chordState[1], chordState[0]);

    // To match VexFlow's accidental column order, we ensure the 
    // Lower Voice (Lead/Bass) is on the left and the Upper Voice (Tenor/Bari) 
    // is shifted to the right during a False Unison clash.
    const nTenor = makeNote(chordState[3], 1, 'treble', tL.upNat, false, tL.isFalse ? 25 : 0);
    const nLead  = makeNote(chordState[2], -1, 'treble', tL.downNat, tL.isUnison, 0);
    
    const nBari  = makeNote(chordState[1], 1, 'bass', bL.upNat, false, bL.isFalse ? 25 : 0);
    const nBass  = makeNote(chordState[0], -1, 'bass', bL.downNat, bL.isUnison, 0);

    const voices = [
        new Voice({num_beats: 1, beat_value: 4}).setStrict(false).addTickables([nTenor]),
        new Voice({num_beats: 1, beat_value: 4}).setStrict(false).addTickables([nLead]),
        new Voice({num_beats: 1, beat_value: 4}).setStrict(false).addTickables([nBari]),
        new Voice({num_beats: 1, beat_value: 4}).setStrict(false).addTickables([nBass])
    ];

    new Formatter().joinVoices([voices[0], voices[1]]).format([voices[0], voices[1]], 400);
    new Formatter().joinVoices([voices[2], voices[3]]).format([voices[2], voices[3]], 400);

    voices.forEach((v, i) => v.draw(context, i < 2 ? topStave : botStave));
}