import type { LocalOcrModel } from '../src/shared/pdf-extraction.js';

export interface ModelAsset {
    file: string;
    url: string;
    bytes: number;
    sha256: string;
}

const publisher = 'https://huggingface.co/PaddlePaddle';
const mediumDetection = `${publisher}/PP-OCRv6_medium_det_onnx/resolve/61323801669c338b7891481ec7bac61ce31b576a`;
const mediumRecognition = `${publisher}/PP-OCRv6_medium_rec_onnx/resolve/50c7eacafc52fa7bcf4194e8cd08e46f8558504b`;
const vlWeights = `${publisher}/PaddleOCR-VL-1.6-GGUF/resolve/511b09642bb324401f15f97cc23bc67e8f0a291d`;
const vlTemplate = `${publisher}/PaddleOCR-VL-1.6/resolve/132c45f52c0a26ed5a6b2f6bd8e3985794cc27dd/chat_template.jinja`;

export const LOCAL_OCR_ASSETS: Readonly<Record<LocalOcrModel, readonly ModelAsset[]>> = {
    'pp-ocrv6-medium': [
        {
            file: 'medium-det/inference.onnx',
            url: `${mediumDetection}/inference.onnx`,
            bytes: 62_032_837,
            sha256: 'eb13b44b25bb36f89528b68720af8a61d9cf381176107f465db1757b65d086e1'
        },
        {
            file: 'medium-det/inference.yml',
            url: `${mediumDetection}/inference.yml`,
            bytes: 886,
            sha256: '7298d5ead546584af2504d03355f881ac7a7bc0eb1e282d3e159277c1d0af871'
        },
        {
            file: 'medium-rec/inference.onnx',
            url: `${mediumRecognition}/inference.onnx`,
            bytes: 76_554_979,
            sha256: '9c09abf0957f7968c7586464b7397b84ad2387a0497a351af40e9acc71b673ba'
        },
        {
            file: 'medium-rec/inference.yml',
            url: `${mediumRecognition}/inference.yml`,
            bytes: 150_580,
            sha256: '991b700facf5b50a7de193468207d5f4255b538dde0d312ae3b7c7a9b6873129'
        }
    ],
    'paddleocr-vl-1.6': [
        {
            file: 'model.gguf',
            url: `${vlWeights}/PaddleOCR-VL-1.6-GGUF.gguf`,
            bytes: 935_769_056,
            sha256: 'f3ae46ec885050acf4b3d31944431e1fd90d50664fb09126af4a3c050ba14ee8'
        },
        {
            file: 'mmproj.gguf',
            url: `${vlWeights}/PaddleOCR-VL-1.6-GGUF-mmproj.gguf`,
            bytes: 881_770_560,
            sha256: '204d757d7610d9b3faab10d506d69e5b244e32bf765e2bab2d0167e65e0a058a'
        },
        {
            file: 'chat_template.jinja',
            url: vlTemplate,
            bytes: 1_474,
            sha256: '2f27812dab7f333e471884e0c803d807f11953d5453140dfb1aaba234f872bc8'
        }
    ]
};
