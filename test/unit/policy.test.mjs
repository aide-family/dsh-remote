/**
 * Unit tests for the ported Crescent static command-risk classifier
 * (`lib/policy/**`, see dsh-remote/docs/ARCHITECTURE.md "Policy contract").
 *
 * Every expectation is a data row: the test name carries the exact command and
 * the expected level, so a failure points at the precise command/level pair.
 *
 * Coverage: read-only baseline, clearly mutating commands, unknown binaries,
 * shell lists/pipelines, quoting and `$`/backtick expansion, redirections,
 * parentheses/subshells, generic wrappers (`env`/`nohup`/`time`/`timeout`/
 * `command`/`nice`/`stdbuf`/`!`), xargs, sudo, `sh -c`, ssh inner, kubectl,
 * docker, systemctl/journalctl and the inspection-argument rules
 * (find/sed/yq/jq/sysctl/ip/curl/secret-file reads).
 *
 * Run: node --test test/unit/policy.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  classifyCommand,
  extractRiskVerb,
  hasHighWriteVerb,
  isStaticallyReadonly
} from '../../lib/policy/index.js'
// Internal helpers asserted for port parity (the public contract is the four
// functions above; these are not part of it).
import { HIGH, READONLY, classifyByStaticRules } from '../../lib/policy/command-guard.js'

/**
 * @typedef {object} ClassifyRow
 * @property {string} command
 * @property {'low' | 'gray' | 'high'} level
 * @property {string} [verb] expected classifyCommand().verb when stable
 */

/** @type {ClassifyRow[]} */
const CLASSIFY_CASES = [
  // ---------------------------------------------------------------- read-only
  { command: 'ls', level: 'low', verb: 'ls' },
  { command: 'ls -la /var/log', level: 'low', verb: 'ls' },
  { command: 'cat /etc/hosts', level: 'low', verb: 'cat' },
  { command: 'grep -R "error" /var/log', level: 'low', verb: 'grep' },
  { command: 'head -20 /var/log/syslog', level: 'low', verb: 'head' },
  { command: 'tail -f /var/log/nginx/access.log', level: 'low', verb: 'tail' },
  { command: 'wc -l /etc/passwd', level: 'low', verb: 'wc' },
  { command: 'df -h', level: 'low', verb: 'df' },
  { command: 'ps aux', level: 'low', verb: 'ps' },
  { command: 'ps aux | grep nginx', level: 'low', verb: 'ps' },
  { command: 'free -m', level: 'low', verb: 'free' },
  { command: 'uptime', level: 'low', verb: 'uptime' },
  { command: 'whoami', level: 'low', verb: 'whoami' },
  { command: 'hostname', level: 'low', verb: 'hostname' },
  { command: 'uname -a', level: 'low', verb: 'uname' },
  { command: 'id', level: 'low', verb: 'id' },
  { command: 'pwd', level: 'low', verb: 'pwd' },
  { command: 'du -sh /var', level: 'low', verb: 'du' },
  { command: 'ss -tlnp', level: 'low', verb: 'ss' },
  { command: 'lsof -i :80', level: 'low', verb: 'lsof' },
  { command: 'journalctl -u nginx', level: 'low', verb: 'journalctl' },
  { command: 'journalctl -f -u nginx', level: 'low', verb: 'journalctl' },
  { command: 'stat /etc/passwd', level: 'low', verb: 'stat' },
  { command: 'which node', level: 'low', verb: 'which' },
  { command: 'top -bn1', level: 'low', verb: 'top' },
  { command: 'ip addr', level: 'low', verb: 'ip' },
  { command: 'sort /etc/hosts', level: 'low', verb: 'sort' },
  { command: 'uniq /etc/hosts', level: 'low', verb: 'uniq' },
  { command: 'cut -d: -f1 /etc/passwd', level: 'low', verb: 'cut' },
  { command: 'tr a-z A-Z', level: 'low', verb: 'tr' },
  { command: 'column -t /etc/hosts', level: 'low', verb: 'column' },
  { command: 'date', level: 'low', verb: 'date' },
  { command: 'hostnamectl', level: 'low', verb: 'hostnamectl' },
  { command: 'jq -r ".name" package.json', level: 'low', verb: 'jq' },
  { command: 'printf "%s\\n" x', level: 'low', verb: 'printf' },
  { command: 'find /var/log -name "*.log"', level: 'low', verb: 'find' },

  // ------------------------------------------------------------ kubectl reads
  { command: 'kubectl get pods -A', level: 'low', verb: 'kubectl get' },
  { command: 'kubectl get pods -n default', level: 'low', verb: 'kubectl get' },
  { command: 'kubectl describe pod x', level: 'low', verb: 'kubectl describe' },
  { command: 'kubectl logs -f pod', level: 'low', verb: 'kubectl logs' },
  { command: 'kubectl top pods', level: 'low', verb: 'kubectl top' },
  { command: 'kubectl diff -f x.yaml', level: 'low', verb: 'kubectl diff' },
  { command: 'kubectl config view', level: 'low', verb: 'kubectl config' },
  { command: 'kubectl auth can-i list pods', level: 'low', verb: 'kubectl auth' },
  { command: 'kubectl --context prod get pods', level: 'low', verb: 'kubectl get' },
  // Tool-verb preference: kubectl/docker/systemctl verbs win for the summary.
  { command: 'kubectl get pods | grep Running', level: 'low', verb: 'kubectl get' },
  { command: 'cat f; docker ps', level: 'low', verb: 'docker ps' },

  // ------------------------------------------------------------- docker reads
  { command: 'docker ps', level: 'low', verb: 'docker ps' },
  { command: 'docker ps -a', level: 'low', verb: 'docker ps' },
  { command: 'docker inspect c', level: 'low', verb: 'docker inspect' },
  { command: 'docker logs c', level: 'low', verb: 'docker logs' },
  { command: 'docker images', level: 'low', verb: 'docker images' },
  { command: 'docker stats', level: 'low', verb: 'docker stats' },
  { command: 'docker version', level: 'low', verb: 'docker version' },
  { command: 'docker info', level: 'low', verb: 'docker info' },
  { command: 'docker history c', level: 'low', verb: 'docker history' },
  { command: 'docker port c', level: 'low', verb: 'docker port' },
  { command: 'docker compose ps', level: 'low', verb: 'docker compose ps' },
  { command: 'docker compose logs', level: 'low', verb: 'docker compose logs' },
  { command: 'docker --context prod ps', level: 'low', verb: 'docker ps' },

  // --------------------------------------------------------- systemctl reads
  { command: 'systemctl status nginx', level: 'low', verb: 'systemctl status' },
  { command: 'systemctl is-active nginx', level: 'low', verb: 'systemctl is-active' },
  { command: 'systemctl --no-pager status nginx', level: 'low', verb: 'systemctl status' },
  { command: 'systemctl show nginx', level: 'low', verb: 'systemctl show' },
  { command: 'systemctl list-units --type=service', level: 'low', verb: 'systemctl list-units' },
  { command: 'systemctl list-timers --all', level: 'low', verb: 'systemctl list-timers' },

  // ------------------------------------------------------- clearly mutating
  { command: 'rm /tmp/x', level: 'high', verb: 'rm' },
  { command: 'rm -rf /tmp/x', level: 'high', verb: 'rm' },
  { command: 'mv a b', level: 'high', verb: 'mv' },
  { command: 'cp a b', level: 'high', verb: 'cp' },
  { command: 'dd if=/dev/zero of=/tmp/f bs=1M count=1', level: 'high', verb: 'dd' },
  { command: 'kill 1234', level: 'high', verb: 'kill' },
  { command: 'kill -9 1234', level: 'high', verb: 'kill' },
  { command: 'reboot', level: 'high', verb: 'reboot' },
  { command: 'mkdir /tmp/x', level: 'high', verb: 'mkdir' },
  { command: 'touch /tmp/x', level: 'high', verb: 'touch' },
  { command: 'chmod 777 f', level: 'high', verb: 'chmod' },
  { command: 'chown ops:ops f', level: 'high', verb: 'chown' },
  { command: 'tee /tmp/out', level: 'high', verb: 'tee' },
  { command: 'echo x | tee -a /var/log/f', level: 'high', verb: 'tee' },
  { command: 'ps aux | tee /tmp/x', level: 'high', verb: 'tee' },

  // ---------------------------------------------------- systemctl mutations
  { command: 'systemctl restart nginx', level: 'high', verb: 'systemctl restart' },
  { command: 'systemctl reload nginx', level: 'high', verb: 'systemctl reload' },
  { command: 'systemctl stop nginx', level: 'high', verb: 'systemctl stop' },
  { command: 'systemctl start nginx', level: 'high', verb: 'systemctl start' },
  { command: 'systemctl enable nginx', level: 'high', verb: 'systemctl enable' },
  { command: 'systemctl disable nginx', level: 'high', verb: 'systemctl disable' },

  // ------------------------------------------------------ kubectl mutations
  { command: 'kubectl delete pod x', level: 'high', verb: 'kubectl delete' },
  { command: 'kubectl apply -f x.yaml', level: 'high', verb: 'kubectl apply' },
  { command: 'kubectl create ns x', level: 'high', verb: 'kubectl create' },
  { command: 'kubectl replace -f x.yaml', level: 'high', verb: 'kubectl replace' },
  { command: "kubectl patch pod x -p '{}'", level: 'high', verb: 'kubectl patch' },
  { command: 'kubectl edit deploy x', level: 'high', verb: 'kubectl edit' },
  { command: 'kubectl rollout restart deployment/x', level: 'high', verb: 'kubectl rollout' },
  { command: 'kubectl scale deploy/x --replicas=2', level: 'high', verb: 'kubectl scale' },
  { command: 'kubectl drain node-1', level: 'high', verb: 'kubectl drain' },
  { command: 'kubectl cordon node-1', level: 'high', verb: 'kubectl cordon' },
  { command: 'kubectl port-forward pod/x 8080:80', level: 'high', verb: 'kubectl port-forward' },

  // ------------------------------------------------------- docker mutations
  { command: 'docker rm c', level: 'high', verb: 'docker rm' },
  { command: 'docker rmi img', level: 'high', verb: 'docker rmi' },
  { command: 'docker restart c', level: 'high', verb: 'docker restart' },
  { command: 'docker stop c', level: 'high', verb: 'docker stop' },
  { command: 'docker run --rm alpine ls', level: 'high', verb: 'docker run' },

  // ------------------------------------------------- inspection writes (high)
  { command: 'find /tmp -name x -delete', level: 'high', verb: 'find' },
  { command: 'find . -name x -exec rm {} +', level: 'high', verb: 'find' },
  { command: "find / -name '*.log' -ok rm {} \\;", level: 'high', verb: 'find' },
  { command: 'sed -i "s/a/b/" f', level: 'high', verb: 'sed' },
  { command: 'sed -i.bak "s/a/b/" f', level: 'high', verb: 'sed' },
  { command: 'sed --in-place "s/a/b/" f', level: 'high', verb: 'sed' },
  { command: 'yq -i ".a=1" f', level: 'high', verb: 'yq' },
  { command: 'jq --in-place . f', level: 'high', verb: 'jq' },
  { command: 'sysctl -w net.ipv4.ip_forward=1', level: 'high', verb: 'sysctl' },
  { command: 'sysctl -p', level: 'high', verb: 'sysctl' },

  // --------------------------------------------------------- sudo (both ways)
  { command: 'sudo rm -rf /tmp/x', level: 'high', verb: 'sudo' },
  { command: 'sudo mv a b', level: 'high', verb: 'sudo' },
  { command: 'sudo tee /etc/f', level: 'high', verb: 'sudo' },
  { command: 'sudo cat /etc/shadow', level: 'high', verb: 'sudo' },
  { command: 'sudo env ls', level: 'high', verb: 'sudo' },
  { command: 'sudo bash -c ls', level: 'high', verb: 'sudo' },
  { command: 'sudo find / -name x', level: 'high', verb: 'sudo' },
  { command: 'sudo watch ls', level: 'high', verb: 'sudo' },
  // Crescent deliberately requires --no-pager for a read-only sudo systemctl.
  { command: 'sudo systemctl status nginx', level: 'high', verb: 'sudo pager' },
  { command: 'sudo kubectl get secrets', level: 'high', verb: 'sudo sensitive/indirect command' },
  { command: 'sudo docker inspect c', level: 'high', verb: 'sudo sensitive/indirect command' },
  { command: 'sudo kubectl exec pod -- ls', level: 'high', verb: 'sudo sensitive/indirect command' },
  {
    command: 'sudo kubectl apply -f x',
    level: 'high',
    verb: 'sudo kubectl apply'
  },
  {
    command: 'sudo systemctl --no-pager restart nginx',
    level: 'high',
    verb: 'sudo systemctl restart'
  },
  { command: 'sudo kubectl get pods', level: 'low', verb: 'kubectl get' },
  { command: 'sudo docker ps', level: 'low', verb: 'docker ps' },
  { command: 'sudo df -h', level: 'low', verb: 'df' },
  { command: 'sudo ss -tlnp', level: 'low', verb: 'ss' },
  { command: 'sudo -- df -h', level: 'low', verb: 'df' },
  { command: 'sudo -n ss -tlnp', level: 'low', verb: 'ss' },
  { command: 'sudo stat /etc/passwd', level: 'low', verb: 'stat' },
  { command: 'sudo id', level: 'low', verb: 'id' },
  { command: 'sudo uname -a', level: 'low', verb: 'uname' },
  { command: 'sudo free -m', level: 'low', verb: 'free' },
  { command: 'sudo systemctl --no-pager status nginx', level: 'low', verb: 'systemctl status' },
  { command: 'sudo systemctl status nginx --no-pager', level: 'low', verb: 'systemctl status' },

  // -------------------------------------------------------------- sh -c inner
  { command: 'sh -c ls', level: 'low', verb: 'ls' },
  { command: 'sh -c "rm -rf /tmp/x"', level: 'high', verb: 'rm' },
  { command: 'sh -c "kubectl get pods"', level: 'low', verb: 'kubectl get' },
  { command: 'bash -c "systemctl stop nginx"', level: 'high', verb: 'systemctl stop' },
  { command: 'dash -c "rm -rf /x"', level: 'high', verb: 'rm' },
  { command: 'zsh -c "docker ps"', level: 'low', verb: 'docker ps' },
  { command: 'ksh -c "uptime"', level: 'low', verb: 'uptime' },
  // Only the exact `-c` form is peeled; combined flags fall back to gray.
  { command: 'bash -lc ls', level: 'gray', verb: 'bash' },
  { command: 'sh -c', level: 'gray', verb: 'sh' },

  // ------------------------------------------------------- ssh inner command
  { command: 'ssh web1 uptime', level: 'low', verb: 'uptime' },
  { command: 'ssh web1 ls -la', level: 'low', verb: 'ls' },
  { command: 'ssh web1 "df -h"', level: 'low', verb: 'df' },
  { command: 'ssh web1 "journalctl -u nginx"', level: 'low', verb: 'journalctl' },
  { command: 'ssh web1 "rm -rf /tmp/x"', level: 'high', verb: 'rm' },
  { command: 'ssh web1 "systemctl restart nginx"', level: 'high', verb: 'systemctl restart' },
  { command: 'ssh web1 "cat /etc/shadow"', level: 'gray', verb: 'cat' },
  { command: 'ssh -p 2222 ops@web1 "kubectl get pods"', level: 'low', verb: 'kubectl get' },
  { command: 'ssh -o BatchMode=yes web1 "ls"', level: 'low', verb: 'ls' },
  // Options that cannot be proven query-only, or a missing remote command.
  { command: 'ssh -v web1 ls', level: 'gray', verb: 'ssh' },
  { command: 'ssh -o StrictHostKeyChecking=no web1 ls', level: 'gray', verb: 'ssh' },
  { command: 'ssh web1', level: 'gray', verb: 'ssh' },

  // ----------------------------------------------------- kubectl exec inner
  { command: 'kubectl exec pod -- ls', level: 'low', verb: 'ls' },
  { command: 'kubectl exec -it pod -- ls', level: 'low', verb: 'ls' },
  { command: 'kubectl exec -n ns -c c pod -- ls', level: 'low', verb: 'ls' },
  { command: 'kubectl exec pod -- rm -f x', level: 'high', verb: 'rm' },
  { command: 'kubectl exec -it pod -- rm -f x', level: 'high', verb: 'rm' },
  {
    command: 'kubectl exec pod -- sh -c "rm -rf /tmp/x"',
    level: 'high',
    verb: 'rm'
  },
  { command: 'kubectl exec pod', level: 'gray', verb: 'kubectl exec' },
  { command: 'kubectl', level: 'gray', verb: 'kubectl' },
  { command: 'kubectl --foo get pods', level: 'gray', verb: 'kubectl' },

  // -------------------------------------------------- kubectl gray heuristics
  { command: 'kubectl get secrets', level: 'gray', verb: 'kubectl sensitive query' },
  { command: 'kubectl get secrets -o yaml', level: 'gray', verb: 'kubectl sensitive query' },
  { command: 'kubectl config set-context x', level: 'gray', verb: 'kubectl config' },
  { command: 'kubectl auth whoami', level: 'gray', verb: 'kubectl auth' },

  // ----------------------------------------------------- docker exec inner
  { command: 'docker exec c ls', level: 'low', verb: 'ls' },
  { command: 'docker exec c rm -rf /tmp/x', level: 'high', verb: 'rm' },
  { command: 'docker exec c sh -c "rm -rf /tmp/x"', level: 'high', verb: 'rm' },
  { command: 'docker exec c sh -c "ps aux"', level: 'low', verb: 'ps' },
  { command: 'docker exec -e FOO=1 c env', level: 'gray', verb: 'docker exec environment' },

  // ------------------------------------------- systemctl/journalctl gray edge
  { command: 'systemctl', level: 'gray', verb: 'systemctl' },
  { command: 'systemctl daemon-reload', level: 'gray', verb: 'systemctl' },
  { command: 'systemctl --root=/x status', level: 'gray', verb: 'systemctl root' },
  { command: 'journalctl --rotate', level: 'gray', verb: 'journalctl' },
  { command: 'journalctl -u x --vacuum-size=1G', level: 'gray', verb: 'journalctl' },

  // --------------------------------------- inspection arguments / secret reads
  { command: 'find . -fprint out', level: 'gray', verb: 'find' },
  { command: 'sed -n "1p" f', level: 'gray', verb: 'sed' },
  { command: 'sed "s/a/b/" f', level: 'gray', verb: 'sed' },
  { command: 'yq ".a" f', level: 'gray', verb: 'yq' },
  { command: 'yq eval ".a" f', level: 'gray', verb: 'yq' },
  { command: 'jq -f prog.jq', level: 'gray', verb: 'jq' },
  { command: 'jq --argfile x f . f', level: 'gray', verb: 'jq' },
  { command: 'sysctl net.ipv4.ip_forward', level: 'low', verb: 'sysctl' },
  { command: 'ip link set eth0 down', level: 'gray', verb: 'ip' },
  { command: 'hostname web1', level: 'gray', verb: 'hostname' },
  { command: 'date -s 2020-01-01', level: 'gray', verb: 'date' },
  { command: 'sort -o out /etc/hosts', level: 'gray', verb: 'sort' },
  { command: 'uniq -c f g', level: 'gray', verb: 'uniq' },
  { command: 'ss -K', level: 'gray', verb: 'ss' },
  { command: 'shasum -c f', level: 'gray', verb: 'shasum' },
  { command: 'hostnamectl set-hostname x', level: 'gray', verb: 'hostnamectl' },
  { command: 'cat /etc/shadow', level: 'gray', verb: 'cat' },
  { command: 'cat .env', level: 'gray', verb: 'cat' },
  // curl is never statically read-only: transport flags cannot prove GET semantics.
  { command: 'curl -s https://example.com', level: 'gray', verb: 'curl' },
  { command: 'curl -X POST https://example.com', level: 'gray', verb: 'curl' },
  { command: 'curl -s -o /tmp/f https://example.com', level: 'gray', verb: 'curl' },

  // ------------------------------------------------------ unknown binaries
  { command: 'mystery-binary --flag', level: 'gray', verb: 'mystery-binary' },
  { command: './script.sh', level: 'gray', verb: 'script.sh' },
  { command: '/usr/local/bin/deploy', level: 'gray', verb: 'deploy' },
  { command: 'ifconfig', level: 'gray', verb: 'ifconfig' },
  { command: 'netstat -tlnp', level: 'gray', verb: 'netstat' },
  { command: 'watch ls', level: 'gray', verb: 'watch' },
  { command: 'ln -s a b', level: 'gray', verb: 'ln' },

  // ------------------------------------------------------------ xargs (gray)
  { command: 'xargs rm', level: 'gray', verb: 'xargs' },
  { command: 'ls | xargs grep x', level: 'gray', verb: 'xargs' },
  { command: 'find . -name x | xargs rm', level: 'gray', verb: 'xargs' },

  // ------------------------------------------------------------ shell lists
  { command: 'ls && rm -rf x', level: 'high', verb: 'rm' },
  { command: 'ls; rm -rf x', level: 'high', verb: 'rm' },
  { command: 'ls || rm -rf x', level: 'high', verb: 'rm' },
  { command: 'ls & rm -rf x', level: 'high', verb: 'rm' },
  { command: 'ls | grep x', level: 'low', verb: 'ls' },
  { command: 'cat f | grep x', level: 'low', verb: 'cat' },
  { command: 'ls -la /etc | head -20', level: 'low', verb: 'ls' },
  { command: 'ls 2>&1 | grep x', level: 'low', verb: 'ls' },
  { command: 'ls | grep x > /dev/null', level: 'low', verb: 'ls' },
  { command: 'sh -c "ls" && cat f', level: 'low', verb: 'ls' },

  // ------------------------------------------------------------ redirections
  { command: 'echo hi > /dev/null', level: 'low', verb: 'echo' },
  { command: 'echo hi 2>&1', level: 'low', verb: 'echo' },
  { command: 'cat f > /dev/null 2>&1', level: 'low', verb: 'cat' },
  { command: 'ls 2>/dev/null | grep x', level: 'low', verb: 'ls' },
  { command: 'ls &> /dev/null', level: 'low', verb: 'ls' },
  { command: 'cat < input', level: 'low', verb: 'cat' },
  { command: 'echo hi > out.txt', level: 'high', verb: '>' },
  { command: 'echo hi >> out.txt', level: 'high', verb: '>' },
  { command: 'cmd &> file', level: 'high', verb: '>' },
  { command: 'kubectl get pods -A > /dev/null', level: 'low', verb: 'kubectl get' },
  { command: 'kubectl get pods > pods.txt', level: 'high', verb: '>' },
  { command: '> file', level: 'high', verb: '>' },

  // ------------------------------------------------ quotes and expansions
  // Text inside single quotes is not a command and not an expansion.
  { command: "echo 'rm -rf /'", level: 'low', verb: 'echo' },
  { command: "echo '$(rm -rf /)'", level: 'low', verb: 'echo' },
  { command: "grep '$HOME' f", level: 'low', verb: 'grep' },
  { command: "echo 'a > b'", level: 'low', verb: 'echo' },
  { command: 'echo "a > b"', level: 'low', verb: 'echo' },
  // Double-quoted/unquoted expansion is unprovable -> gray (or high if inner is high).
  { command: 'echo "$HOME"', level: 'gray', verb: 'echo' },
  { command: 'grep "$HOME" f', level: 'gray', verb: 'grep' },
  { command: 'echo $(ls)', level: 'gray', verb: 'echo' },
  { command: 'echo `ls`', level: 'gray', verb: 'echo' },
  { command: 'echo $(rm -rf /)', level: 'high', verb: 'rm' },
  { command: 'echo `rm -rf /tmp/x`', level: 'high', verb: 'rm' },
  // Awk `$1` in single quotes is not an expansion; awk is gray for the
  // unsafe-inspection rule (awk can write files), not for expansion.
  { command: "awk '{print $1}' f", level: 'gray', verb: 'awk' },
  { command: "ps aux | awk '{print $1}'", level: 'gray', verb: 'awk' },
  { command: 'FOO=1 ls', level: 'gray', verb: 'ls' },
  { command: 'FOO=bar', level: 'gray', verb: 'change' },
  { command: 'echo $((1+2))', level: 'gray', verb: 'change' },

  // ------------------------------------------- wrappers (env/nohup/time/...)
  { command: 'env ls', level: 'gray', verb: 'environment/wrapper' },
  { command: 'env FOO=bar ls', level: 'gray', verb: 'environment/wrapper' },
  { command: 'nohup ls', level: 'gray', verb: 'environment/wrapper' },
  { command: 'time ls', level: 'gray', verb: 'environment/wrapper' },
  { command: 'timeout 30 ls', level: 'low', verb: 'ls' },
  { command: 'timeout -s KILL 5 rm -rf /x', level: 'high', verb: 'rm' },
  { command: 'timeout 5 sh -c "rm -rf /x"', level: 'high', verb: 'rm' },
  { command: 'timeout 10 kubectl delete pod x', level: 'high', verb: 'kubectl delete' },
  { command: 'command ls', level: 'low', verb: 'ls' },
  { command: 'command -v ls', level: 'low', verb: 'ls' },
  { command: 'nice -n 10 ls', level: 'low', verb: 'ls' },
  { command: 'stdbuf -oL ls', level: 'low', verb: 'ls' },
  { command: 'stdbuf -oL tail -f /var/log/x', level: 'low', verb: 'tail' },
  { command: 'nice -n 5 systemctl restart nginx', level: 'high', verb: 'systemctl restart' },
  { command: 'command kubectl delete pod x', level: 'high', verb: 'kubectl delete' },
  { command: '! ls', level: 'low', verb: 'ls' },
  { command: '! rm -rf /x', level: 'high', verb: 'rm' },

  // ------------------------------------------------- parentheses / subshells
  // Parentheses are unquoted shell meta characters the bounded parser cannot
  // prove; the whole command falls back to gray.
  { command: '(ls)', level: 'gray', verb: 'change' },
  { command: '(cd /tmp && ls)', level: 'gray', verb: 'change' },
  { command: '(kubectl get pods)', level: 'gray', verb: 'change' },
  { command: 'ls && (cat f)', level: 'gray', verb: 'change' },
  { command: 'echo (x)', level: 'gray', verb: 'change' },

  // ------------------------------------------------------------ malformed
  { command: '', level: 'gray', verb: 'change' },
  { command: '   ', level: 'gray', verb: 'change' },
  { command: 'ls >', level: 'gray', verb: 'change' }
]

let caseNumber = 0
for (const row of CLASSIFY_CASES) {
  const label = `${++caseNumber}. classify ${JSON.stringify(row.command)} -> ${row.level}`
  test(label, () => {
    const result = classifyCommand(row.command)
    assert.deepEqual(Object.keys(result).sort(), ['level', 'verb'])
    assert.equal(result.level, row.level, `level for ${JSON.stringify(row.command)}`)
    if (row.verb !== undefined) {
      assert.equal(result.verb, row.verb, `verb for ${JSON.stringify(row.command)}`)
    }

    // Contract equivalence: the boolean helpers mirror the level.
    assert.equal(
      isStaticallyReadonly(row.command),
      row.level === 'low',
      `isStaticallyReadonly for ${JSON.stringify(row.command)}`
    )
    assert.equal(
      hasHighWriteVerb(row.command),
      row.level === 'high',
      `hasHighWriteVerb for ${JSON.stringify(row.command)}`
    )
    assert.equal(
      classifyByStaticRules(row.command),
      row.level,
      `classifyByStaticRules for ${JSON.stringify(row.command)}`
    )

    // extractRiskVerb always returns a usable, non-empty summary verb.
    const riskVerb = extractRiskVerb(row.command)
    assert.equal(typeof riskVerb, 'string')
    assert.ok(riskVerb.length > 0, 'extractRiskVerb must not be empty')

    // For high-risk commands the summary verb is the winning high-risk verb.
    if (row.level === 'high' && row.verb !== undefined) {
      assert.equal(
        riskVerb,
        row.verb,
        `extractRiskVerb for high-risk ${JSON.stringify(row.command)}`
      )
    }
  })
}

// ---------------------------------------------------------------------------
// extractRiskVerb-specific expectations (tool verbs, low verbs, fallback)
// ---------------------------------------------------------------------------

/** @type {{ command: string, verb: string }[]} */
const RISK_VERB_CASES = [
  { command: 'ls', verb: 'ls' },
  { command: 'ps aux | grep nginx', verb: 'ps' },
  { command: 'kubectl get pods -A', verb: 'kubectl get' },
  { command: 'systemctl status nginx', verb: 'systemctl status' },
  { command: 'docker ps', verb: 'docker ps' },
  { command: 'python3 manage.py migrate', verb: 'change' },
  { command: 'ls | xargs grep x', verb: 'ls' },
  { command: 'kubectl get secrets', verb: 'change' },
  { command: '(ls)', verb: 'change' },
  { command: '', verb: 'change' },
  { command: 'rm -rf /', verb: 'rm' },
  { command: 'sh -c "rm -rf /"', verb: 'rm' },
  { command: 'sudo rm -rf /', verb: 'sudo' },
  { command: 'echo hi > /tmp/f', verb: '>' },
  { command: 'kubectl exec pod -- ls', verb: 'ls' },
  { command: 'ps aux | grep x && kubectl delete pod y', verb: 'kubectl delete' }
]

for (const row of RISK_VERB_CASES) {
  test(`extractRiskVerb ${JSON.stringify(row.command)} -> ${row.verb}`, () => {
    assert.equal(extractRiskVerb(row.command), row.verb)
  })
}

// ---------------------------------------------------------------------------
// Ported HIGH / READONLY token regexes still recognize their canonical forms.
// ---------------------------------------------------------------------------

test('HIGH regex matches the high-risk canonical forms', () => {
  for (const command of [
    'rm -rf /tmp/x',
    'mv a b',
    'dd if=/dev/zero of=f',
    'kill 1234',
    'reboot',
    'systemctl restart nginx',
    'kubectl delete pod x',
    'kubectl apply -f x.yaml',
    'docker restart c',
    'docker rm c',
    'chmod 777 f',
    'chown a:b f',
    'tee /tmp/f'
  ]) {
    assert.equal(HIGH.test(command), true, `HIGH should match ${JSON.stringify(command)}`)
  }
})

test('READONLY regex matches the canonical read-only forms', () => {
  for (const command of [
    'kubectl get pods',
    'kubectl describe pod x',
    'docker ps',
    'docker compose logs',
    'systemctl status nginx',
    'journalctl -u nginx',
    'cat /etc/hosts',
    'ls -la',
    'grep x f',
    'df -h',
    'curl -s https://example.com'
  ]) {
    assert.equal(READONLY.test(command), true, `READONLY should match ${JSON.stringify(command)}`)
  }
})

// ---------------------------------------------------------------------------
// Determinism / purity: repeated calls return equal, independent results.
// ---------------------------------------------------------------------------

test('classifyCommand is deterministic and returns fresh objects', () => {
  const first = classifyCommand('kubectl get pods -A')
  const second = classifyCommand('kubectl get pods -A')
  assert.deepEqual(first, second)
  assert.notEqual(first, second)
  first.level = 'high'
  assert.equal(classifyCommand('kubectl get pods -A').level, 'low')
})
