"""Convert the verified upstream weights; no model training or downloads here."""
import hashlib
import sys
from pathlib import Path
import torch
import torchvision.transforms.functional as functional
sys.modules['torchvision.transforms.functional_tensor'] = functional
import onnx
from gfpgan.archs.gfpganv1_clean_arch import GFPGANv1Clean
from realesrgan.archs.srvgg_arch import SRVGGNetCompact

root = Path(__file__).resolve().parents[1] / 'bin' / 'ai' / 'models'
torch.set_num_threads(6)
hashes = {
    'GFPGANv1.4.pth': 'e2cd4703ab14f4d01fd1383a8a8b266f9a5833dacee8e6a79d3bf21a1b6be5ad',
    'realesr-general-x4v3.pth': '8dc7edb9ac80ccdc30c3a5dca6616509367f05fbc184ad95b731f05bece96292',
}
for name, expected in hashes.items():
    if hashlib.sha256((root / name).read_bytes()).hexdigest() != expected:
        raise ValueError('Upstream model hash mismatch: ' + name)

class Face(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.model = GFPGANv1Clean(out_size=512, num_style_feat=512, channel_multiplier=2,
            decoder_load_path=None, fix_decoder=False, num_mlp=8, input_is_latent=True,
            different_w=True, narrow=1, sft_half=True)
        self.model.load_state_dict(torch.load(root / 'GFPGANv1.4.pth', map_location='cpu', weights_only=True)['params_ema'])
    def forward(self, x):
        return self.model(x, return_rgb=False, randomize_noise=False)[0]

models = [('face', Face(), 512)]
denoise = SRVGGNetCompact(num_in_ch=3, num_out_ch=3, num_feat=64, num_conv=32, upscale=4, act_type='prelu')
denoise.load_state_dict(torch.load(root / 'realesr-general-x4v3.pth', map_location='cpu', weights_only=True)['params'])
models.append(('denoise', denoise, 256))
for name, model, size in models:
    dest = root / (name + '.onnx')
    print('Exporting', name, flush=True)
    torch.onnx.export(model.eval(), torch.zeros(1, 3, size, size), str(dest),
        input_names=['image'], output_names=['restored'], opset_version=17, dynamo=False)
    onnx.checker.check_model(str(dest))
    print(name, dest.stat().st_size, hashlib.sha256(dest.read_bytes()).hexdigest(), flush=True)
