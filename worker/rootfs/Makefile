ROOTFS_DIR ?= /var/lib/firecracker/rootfs
VSOCK_AGENT_DIR := ../vsock-agent

IMAGES := base node-20

.PHONY: all clean vsock-agent install

all: vsock-agent $(addsuffix .ext4,$(IMAGES))

vsock-agent:
	$(MAKE) -C $(VSOCK_AGENT_DIR) build

%.ext4: %.Dockerfile vsock-agent
	@echo "==> Building $* rootfs..."
	docker build -t arcagent-rootfs-$* -f $< .
	$(eval CID := $(shell docker create arcagent-rootfs-$*))
	docker export $(CID) | dd of=$@ bs=1M status=progress
	docker rm $(CID) >/dev/null
	resize2fs -M $@
	@echo "==> Built $@ ($$(du -h $@ | cut -f1))"

install: all
	mkdir -p $(ROOTFS_DIR)
	cp *.ext4 $(ROOTFS_DIR)/

clean:
	rm -f *.ext4
	$(MAKE) -C $(VSOCK_AGENT_DIR) clean
