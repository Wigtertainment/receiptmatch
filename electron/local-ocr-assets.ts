export interface IModelAsset {
    file: string;
    url: string;
    bytes: number;
    sha256: string;
}

const nuExtractRevision: string = '28a1aae6288c5d50bdf999ca2e572240966d669b';
const nuExtractSource: string = 'https://huggingface.co/numind/NuExtract3-GGUF/resolve/' + nuExtractRevision;

export const NUEXTRACT_ASSETS: readonly [IModelAsset, IModelAsset] = [
    {
        file: 'NuExtract3-Q4_K_M.gguf',
        url: nuExtractSource + '/NuExtract3-Q4_K_M.gguf',
        bytes: 2_783_445_984,
        sha256: '7ee3c0ee9e5699a4391624ae758487f583f73b3242aa4e73dc2bb33e508d703e'
    },
    {
        file: 'mmproj-NuExtract3-BF16.gguf',
        url: nuExtractSource + '/mmproj-NuExtract3-BF16.gguf',
        bytes: 675_569_184,
        sha256: '9a506ce43544691f4f56f1533768f43e1887ef69b8cd74b2e7a46c4d9a155a01'
    }
];
