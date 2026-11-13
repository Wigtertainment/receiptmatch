import json
import os
import sys
from importlib.metadata import version


def deny_network(event, _args):
    if event in {
        'socket.bind', 'socket.connect', 'socket.getaddrinfo', 'socket.gethostbyaddr',
        'socket.gethostbyname', 'socket.getnameinfo', 'socket.sendto', 'socket.sendmsg',
    }:
        raise RuntimeError('Network access is disabled during OCR.')


def rectangle(text, boxes):
    return {
        'text': text,
        'x0': min(int(box[0]) for box in boxes),
        'y0': min(int(box[1]) for box in boxes),
        'x1': max(int(box[2]) for box in boxes),
        'y1': max(int(box[3]) for box in boxes),
    }


def words_in_line(text, pieces, boxes, line_box):
    words = text.split()
    if not words:
        return []
    # CTC word boxes can split one printed word at punctuation or an accented letter.
    fragments = [''.join(piece.split()) for piece in pieces]
    if ''.join(fragments) != ''.join(words) or len(fragments) != len(boxes):
        return [rectangle(text, [line_box])]
    positions = []
    for fragment, box in zip(fragments, boxes, strict=True):
        positions.extend([box] * len(fragment))
    regions = []
    offset = 0
    for word in words:
        end = offset + len(word)
        if end < len(positions) and positions[end - 1] is positions[end]:
            return [rectangle(text, [line_box])]
        regions.append(rectangle(word, positions[offset:end]))
        offset = end
    return regions


def recognize(detection, recognition, width, height):
    import cv2
    import numpy as np
    import onnxruntime

    onnxruntime.disable_telemetry_events()
    if version('paddleocr') != '3.7.0':
        raise RuntimeError('PaddleOCR 3.7.0 is required for this engine.')
    from paddleocr import PaddleOCR

    encoded = np.frombuffer(sys.stdin.buffer.read(), dtype=np.uint8)
    image = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
    if image is None or image.shape[:2] != (height, width):
        raise ValueError('The OCR image dimensions do not match the page.')

    ocr = PaddleOCR(
        device='cpu', engine='onnxruntime',
        engine_config={'providers': ['CPUExecutionProvider'], 'intra_op_num_threads': 4},
        use_doc_orientation_classify=False, use_doc_unwarping=False, use_textline_orientation=False,
        text_detection_model_name='PP-OCRv6_medium_det', text_detection_model_dir=detection,
        text_recognition_model_name='PP-OCRv6_medium_rec', text_recognition_model_dir=recognition,
    )
    result = ocr.predict(image, return_word_box=True)[0].json['res']
    if not result['rec_texts']:
        return []
    return [
        region
        for text, pieces, boxes, line in zip(result['rec_texts'], result['text_word'], result['text_word_boxes'], result['rec_boxes'], strict=True)
        for region in words_in_line(text, pieces, boxes, line)
        if region['x1'] > region['x0'] and region['y1'] > region['y0']
    ]


if __name__ == '__main__':
    sys.addaudithook(deny_network)
    # Keep dependency logging out of the JSON protocol, including writes to stdout's file descriptor.
    with os.fdopen(os.dup(sys.stdout.fileno()), 'w', encoding='utf-8') as response:
        os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
        detection, recognition, width, height = sys.argv[1:]
        json.dump(recognize(detection, recognition, int(width), int(height)), response, ensure_ascii=False)
